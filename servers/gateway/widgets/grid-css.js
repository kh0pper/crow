/**
 * The grid's styles (widgets phase 2, spec §7.3). Emitted by For You next to its own stylesheet, and
 * reused by any page that draws `gridHtml`.
 *
 * Fixed columns, no free placement: 2 on a phone, 4 from 720 px. A cell's `data-w` is how many
 * columns it asks for — `4` is the whole row on either grid, `2` is a full phone row and half a wide
 * one, `1` is a half phone row — and `data-h` sets its minimum height only (content may always grow
 * past it: a size must never hide a story or a button). Every control is at least 44 px, and a cell
 * never widens the page: text wraps anywhere, so a long or RTL title clips inside its cell instead
 * of growing the grid.
 *
 * Edit mode is `[data-editing]` on the grid: the Remove and Size buttons come out, a dashed outline
 * marks each cell, and the widget's own content stops taking clicks so a drag can start anywhere on
 * the cell. The shell's swipe reveal must ignore a gesture that starts inside
 * `.wg-grid[data-editing]` (widgets phase 2, Task 4).
 *
 * NOTE: never write a literal closing style tag inside a comment here.
 */
export function widgetsGridCss() {
  return `<style>
  .wg-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; min-width: 0; }
  .wg-grid [hidden], .wg-picker [hidden] { display: none !important; }
  .wg-bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .wg-hint { grid-column: 1 / -1; margin: 0; }
  .wg-status { grid-column: 1 / -1; min-height: 0; }
  .wg-cell { position: relative; min-width: 0; grid-column: span 2; min-height: 96px; }
  .wg-cell[data-w="1"] { grid-column: span 1; }
  .wg-cell[data-w="2"] { grid-column: span 2; }
  .wg-cell[data-w="4"] { grid-column: 1 / -1; }
  .wg-cell[data-h="2"] { min-height: 200px; }
  .wg-cell-body { display: flex; flex-direction: column; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .wg-cell-body > * { min-width: 0; max-width: 100%; }
  .wg-remove, .wg-size { display: none; position: absolute; z-index: 3; min-width: 44px; min-height: 44px; padding: 0 10px; }
  .wg-remove { top: 4px; right: 4px; }
  .wg-size { right: 4px; bottom: 4px; }
  .wg-grid[data-editing] .wg-remove, .wg-grid[data-editing] .wg-size { display: inline-flex; }
  .wg-grid[data-editing] .wg-cell {
    outline: 1px dashed var(--crow-border-strong, var(--crow-border)); outline-offset: 2px;
    touch-action: pan-y; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  .wg-grid[data-editing] .wg-cell-body { pointer-events: none; }
  .wg-cell[data-wg-dragging] { opacity: 0.6; }
  .wg-cell[data-wg-dragging] .wg-cell-body { pointer-events: none; }
  .wg-picker {
    margin: auto auto 0; width: 100%; max-width: 40rem; max-height: 85vh; padding: 0; box-sizing: border-box;
    border: 1px solid var(--crow-border); border-bottom: 0; border-radius: 20px 20px 0 0;
    background: var(--crow-bg-surface); color: var(--crow-text-primary);
  }
  .wg-picker::backdrop { background: rgba(0, 0, 0, 0.45); }
  .wg-picker-inner { display: flex; flex-direction: column; gap: 12px; padding: 18px 16px calc(24px + env(safe-area-inset-bottom, 0px)); }
  .wg-picker-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .wg-picker-add { width: 100%; min-height: 44px; justify-content: flex-start; text-align: left; }
  .wg-grid button { min-height: 44px; }
  .wg-grid button:focus-visible, .wg-picker button:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  @media (min-width: 720px) { .wg-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (min-width: 1024px) { .wg-picker { margin: auto; border-bottom: 1px solid var(--crow-border); border-radius: 20px; } }
</style>`;
}