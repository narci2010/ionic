import { Component, Element, EventListenerEnable, Listen, Method, Prop, Watch } from '@stencil/core';
import { DomController } from '../../index';
import { Cell, DomRenderFn, HeaderFn, ItemHeightFn,
  ItemRenderFn, NodeHeightFn, Range, Viewport,
  VirtualNode, calcCells, calcHeightIndex, doRender,
  findCellIndex, getRange, getShouldUpdate, getViewport,
  inplaceUpdate, positionForIndex, resizeBuffer, updateVDom } from './virtual-scroll-utils';


@Component({
  tag: 'ion-virtual-scroll',
  styleUrl: 'virtual-scroll.scss'
})
export class VirtualScroll {

  private scrollEl: HTMLIonScrollElement | null;
  private range: Range = {offset: 0, length: 0};
  private timerUpdate: any;
  private heightIndex: Uint32Array;
  private viewportHeight: number;
  private cells: Cell[] = [];
  private virtualDom: VirtualNode[] = [];
  private isEnabled = false;
  private viewportOffset = 0;
  private currentScrollTop = 0;
  private indexDirty = 0;
  private totalHeight = 0;
  private heightChanged = false;
  private lastItemLen = 0;

  @Element() el: HTMLElement;

  @Prop({context: 'dom'}) dom: DomController;
  @Prop({context: 'enableListener'}) enableListener: EventListenerEnable;


  /**
   * It is important to provide this
   * if virtual item height will be significantly larger than the default
   * The approximate height of each virtual item template's cell.
   * This dimension is used to help determine how many cells should
   * be created when initialized, and to help calculate the height of
   * the scrollable area. This height value can only use `px` units.
   * Note that the actual rendered size of each cell comes from the
   * app's CSS, whereas this approximation is used to help calculate
   * initial dimensions before the item has been rendered. Default is
   * `45`.
   */
  @Prop() approxItemHeight = 45;

  /**
   * The approximate height of each header template's cell.
   * This dimension is used to help determine how many cells should
   * be created when initialized, and to help calculate the height of
   * the scrollable area. This height value can only use `px` units.
   * Note that the actual rendered size of each cell comes from the
   * app's CSS, whereas this approximation is used to help calculate
   * initial dimensions before the item has been rendered. Default is `40px`.
   */
  @Prop() approxHeaderHeight = 40;

  /**
   * The approximate width of each footer template's cell.
   * This dimension is used to help determine how many cells should
   * be created when initialized, and to help calculate the height of
   * the scrollable area. This value can use either `px` or `%` units.
   * Note that the actual rendered size of each cell comes from the
   * app's CSS, whereas this approximation is used to help calculate
   * initial dimensions before the item has been rendered. Default is `100%`.
   */
  @Prop() approxFooterHeight = 40;

  /**
   * Section headers and the data used within its given
   * template can be dynamically created by passing a function to `headerFn`.
   * For example, a large list of contacts usually has dividers between each
   * letter in the alphabet. App's can provide their own custom `headerFn`
   * which is called with each record within the dataset. The logic within
   * the header function can decide if the header template should be used,
   * and what data to give to the header template. The function must return
   * `null` if a header cell shouldn't be created.
   */
  @Prop() headerFn: HeaderFn;

  /**
   * Section footers and the data used within its given
   * template can be dynamically created by passing a function to `footerFn`.
   * The logic within the footer function can decide if the footer template
   * should be used, and what data to give to the footer template. The function
   * must return `null` if a footer cell shouldn't be created.
   */
  @Prop() footerFn: HeaderFn;

  /**
   * The data that builds the templates within the virtual scroll.
   * This is the same data that you'd pass to `*ngFor`. It's important to note
   * that when this data has changed, then the entire virtual scroll is reset,
   * which is an expensive operation and should be avoided if possible.
   */
  @Prop() items: any[];

  @Prop() renderer: (item: any) => JSX.Element;
  @Prop() nodeHeight: NodeHeightFn;
  @Prop() itemHeight: ItemHeightFn;
  @Prop() itemRender: ItemRenderFn;
  @Prop() domRender: DomRenderFn;

  @Watch('itemHeight')
  @Watch('items')
  itemsChanged() {
    this.calcCells();
  }

  componentDidLoad() {
    this.scrollEl = this.el.closest('ion-scroll');
    if (!this.scrollEl) {
      console.error('virtual-scroll must be used inside ion-scroll/ion-content');
      return;
    }
    this.scrollEl.componentOnReady().then(() => {
      this.calcDimensions();
      this.calcCells();
      this.updateState();
    });
  }

  componentDidUpdate() {
    this.updateState();
  }

  componentDidUnload() {
    this.scrollEl = null;
  }

  @Listen('scroll', {enabled: false, passive: false})
  onScroll() {
    this.updateVirtualScroll();
  }

  @Listen('window:resize')
  onResize() {
    this.indexDirty = 0;
    this.calcDimensions();
    this.calcCells();
    this.updateVirtualScroll();
  }

  @Method()
  positionForItem(index: number): number {
    return positionForIndex(index, this.cells, this.heightIndex);
  }

  @Method()
  markDirty(offset: number, len = -1) {
    // TODO: kind of hacky how we do in-place updated of the cells
    // array. this part needs a complete refactor
    if (!this.items) {
      return;
    }
    if (len === -1) {
      len = this.items.length - offset;
    }
    const max = this.lastItemLen;
    let j = 0;
    if (offset > 0 && offset < max) {
      j = findCellIndex(this.cells, offset);
    } else if (offset === 0) {
      j = 0;
    } else if (offset === max) {
      j = this.cells.length;
    } else {
      console.warn('bad values for markDirty');
      return;
    }
    const cells = calcCells(
      this.items,
      this.itemHeight,
      this.headerFn,
      this.footerFn,
      this.approxHeaderHeight,
      this.approxFooterHeight,
      this.approxItemHeight,
      j, offset, len
    );
    console.debug('[virtual] cells recalculated', cells.length);
    this.cells = inplaceUpdate(this.cells, cells, offset);
    this.lastItemLen = this.items.length;
    this.indexDirty = Math.max(offset - 1, 0);

    this.scheduleUpdate();
  }

  @Method()
  markDirtyTail() {
    const offset = this.lastItemLen;
    this.markDirty(offset, this.items.length - offset);
  }

  private updateVirtualScroll() {
    // do nothing if there is a scheduled update
    if (!this.isEnabled || !this.scrollEl) {
      return;
    }
    if (this.timerUpdate) {
      clearTimeout(this.timerUpdate);
      this.timerUpdate = null;
    }

    this.dom.read(this.readVS.bind(this));
    this.dom.read(this.writeVS.bind(this));
  }

  private readVS() {
    let topOffset = 0;
    let node: HTMLElement | null = this.el;
    while (node && node !== this.scrollEl) {
      topOffset += node.offsetTop;
      node = node.parentElement;
    }
    this.viewportOffset = topOffset;
    if (this.scrollEl) {
      this.currentScrollTop = this.scrollEl.scrollTop;
    }
  }

  private writeVS() {
    const dirtyIndex = this.indexDirty;

    // get visible viewport
    const scrollTop = this.currentScrollTop - this.viewportOffset;
    const viewport = getViewport(scrollTop, this.viewportHeight, 100);

    // compute lazily the height index
    const heightIndex = this.getHeightIndex(viewport);

    // get array bounds of visible cells base in the viewport
    const range = getRange(heightIndex, viewport, 2);

    // fast path, do nothing
    const shouldUpdate = getShouldUpdate(dirtyIndex, this.range, range);
    if (!shouldUpdate) {
      return;
    }
    this.range = range;

    // in place mutation of the virtual DOM
    updateVDom(
      this.virtualDom,
      heightIndex,
      this.cells,
      range
    );

    // write DOM
    if (this.itemRender) {
      doRender(this.el, this.itemRender, this.virtualDom, this.updateCellHeight.bind(this));
    } else if (this.domRender) {
      this.domRender(this.virtualDom);
    } else if (this.renderer) {
      (this.el as any).forceUpdate();
    }
    if (this.heightChanged) {
      this.el.style.height = this.totalHeight + 'px';
      this.heightChanged = false;
    }
  }

  private updateCellHeight(cell: Cell, node: HTMLStencilElement | HTMLElement) {
    const update = () => {
      if ((node as any)['$ionCell'] === cell) {
        const style = window.getComputedStyle(node);
        const height = node.offsetHeight + parseFloat(style.getPropertyValue('margin-bottom'));
        this.setCellHeight(cell, height);
      }
    };
    if ('componentOnReady' in node) {
      node.componentOnReady(update);
    } else {
      update();
    }
  }

  private setCellHeight(cell: Cell, height: number) {
    const index = cell.i;
    // the cell might changed since the height update was scheduled
    if (cell !== this.cells[index]) {
      return;
    }
    cell.visible = true;
    if (cell.height !== height) {
      console.debug(`[virtual] cell height changed ${cell.height}px -> ${height}px`);
      cell.height = height;
      this.indexDirty = Math.min(this.indexDirty, index);
      this.scheduleUpdate();
    }
  }

  private scheduleUpdate() {
    clearTimeout(this.timerUpdate);
    this.timerUpdate = setTimeout(() => this.updateVirtualScroll(), 100);
  }

  private updateState() {
    const shouldEnable = !!(
      this.scrollEl &&
      this.cells &&
      this.viewportHeight > 1
    );
    if (shouldEnable !== this.isEnabled) {
      this.enableScrollEvents(shouldEnable);
      if (shouldEnable) {
        this.updateVirtualScroll();
      }
    }
  }


  private calcCells() {
    if (!this.items) {
      return;
    }
    this.lastItemLen = this.items.length;
    this.cells = calcCells(
      this.items,
      this.itemHeight,
      this.headerFn,
      this.footerFn,
      this.approxHeaderHeight,
      this.approxFooterHeight,
      this.approxItemHeight,
      0, 0, this.lastItemLen
    );
    console.debug('[virtual] cells recalculated', this.cells.length);
    this.indexDirty = 0;
  }

  private getHeightIndex(_: Viewport): Uint32Array {
    if (this.indexDirty !== Infinity) {
      this.calcHeightIndex(this.indexDirty);
    }
    return this.heightIndex;
  }

  private calcHeightIndex(index = 0) {
    // TODO: optimize, we don't need to calculate all the cells
    this.heightIndex = resizeBuffer(this.heightIndex, this.cells.length);
    const totalHeight = calcHeightIndex(this.heightIndex, this.cells, index);
    if (totalHeight !== this.totalHeight) {
      console.debug(`[virtual] total height changed: ${this.totalHeight}px -> ${totalHeight}px`);
      this.totalHeight = totalHeight;
      this.heightChanged = true;
    }
    console.debug('[virtual] height index recalculated', this.heightIndex.length - index);
    this.indexDirty = Infinity;
  }

  private calcDimensions() {
    if (this.scrollEl) {
      this.viewportHeight = this.scrollEl.offsetHeight;
    }
  }

  private enableScrollEvents(shouldListen: boolean) {
    if (this.scrollEl) {
      this.isEnabled = shouldListen;
      this.enableListener(this, 'scroll', shouldListen, this.scrollEl);
    }
  }

  render() {
    const renderer = this.renderer;
    if (renderer) {
      return this.virtualDom.map((dom) => {
        const item = renderer(dom.cell.value) as any;
        const classes = ['virtual-item'];
        if (!item.vattrs) {
          item.vattrs = {};
        }
        item.vattrs.class += ' virtual-item';
        if (!dom.visible) {
          classes.push('virtual-loading');
        }
        item.vattrs.class += ' ' + classes.join(' ');
        if (!item.vattrs.style) {
          item.vattrs.style = {};
        }
        item.vattrs.style['transform'] = `translate3d(0,${dom.top}px,0)`;
        return item;
      });
    }
    return undefined;
  }
}
