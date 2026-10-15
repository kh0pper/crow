/**
 * Extensions: the one "Local models" card (models plan 3a, Task 4). Model
 * bundles (`inference: true`) no longer appear in Browse; this card in the
 * AI group points at the Model Catalog instead. It reuses the add-on card
 * skeleton (and its data attributes, so search finds it) but carries no
 * install button: it is a link. Its id is not in the client's ADDON_DATA,
 * so clicking the card body opens no detail modal.
 *
 * PURE apart from `localModelsCounts`'s injected listing function.
 */
import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { appIconSvg } from "../../shared/app-icons.js";

/**
 * `{ registered, resident }` from the lifecycle listing (provider rows, not
 * registry keys): registered = every row that is not another instance's,
 * resident = running here or an external engine that is up. Any failure
 * reads as zero rather than breaking the Extensions page.
 */
export function localModelsCounts(listingFn) {
  try {
    const rows = listingFn() || [];
    return {
      registered: rows.filter((r) => r.status !== "foreign").length,
      resident: rows.filter((r) => r.status === "resident" || r.status === "external_up").length,
    };
  } catch {
    return { registered: 0, resident: 0 };
  }
}

/** @param {{registered:number, resident:number}} counts @param {{bg:string,color:string}} catColor */
export function renderLocalModelsCard(counts, catColor, lang) {
  const name = t("extensions.localModelsName", lang);
  const desc = t("extensions.localModelsDesc", lang);
  const count = fill(t("extensions.localModelsCount", lang), {
    registered: Number(counts?.registered) || 0,
    resident: Number(counts?.resident) || 0,
  });
  return `<div class="ext-card addon-card" data-addon-id="local-models" data-addon-type="link" data-addon-category="ai" data-addon-group="ai" data-addon-name="${escapeHtml(name.toLowerCase())}" data-addon-desc="${escapeHtml(desc.toLowerCase())}" data-addon-tags="models,llm,gguf,llama.cpp">
          <div class="ext-card__icon" style="background:${catColor.bg};color:${catColor.color}">${appIconSvg("models")}</div>
          <div class="ext-card__body">
            <div class="ext-card__name">${escapeHtml(name)}</div>
            <p class="ext-card__desc">${escapeHtml(desc)}</p>
            <div class="ext-card__meta"><span class="ext-card__badge ext-card__badge--type">${escapeHtml(count)}</span></div>
          </div>
          <div class="ext-card__footer"><a class="btn btn-sm btn-primary" href="/dashboard/model-catalog">${escapeHtml(t("extensions.localModelsOpen", lang))}</a></div>
        </div>`;
}
