/**
 * The browser block's operator-approved copy (2026-11-19) is byte-exact wherever it
 * lands: the Fix-it card's COPY object (EN + ES), the install consent message in the
 * bundle manifest (its final sentence), and the turn-end paragraph of the guide
 * (EN + ES). The strings below are the approved text; the files must equal them
 * character for character — no smart quotes, no re-wrapped words, no paraphrase.
 *
 * Nothing here touches ~/.crow: the detector module is imported read-only, and the
 * manifest and guides are read from this checkout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const APPROVED = {
  title: {
    en: "The browser add-on is still running the old version",
    es: "El complemento del navegador sigue ejecutando la versión anterior",
  },
  body: {
    en: "Crow updated the browser add-on, but the copy that is running is still the old one. Restart it to load the update. A restart cannot be undone, and the pages that are open in the browser now will close. Saved logins and cookies are kept.",
    es: "Crow actualizó el complemento del navegador, pero la copia que está en marcha sigue siendo la anterior. Reinícialo para cargar la actualización. Un reinicio no se puede deshacer, y las páginas que están abiertas ahora en el navegador se cerrarán. Los inicios de sesión y las cookies guardados se conservan.",
  },
  restartAction: {
    en: "Restart the browser add-on",
    es: "Reiniciar el complemento del navegador",
  },
  openExtensions: {
    en: "Open Extensions",
    es: "Abrir Extensiones",
  },
};

const APPROVED_CONSENT = {
  en: "Crow's own browser tools refuse private and local-network addresses (loopback, LAN, tailnet, link-local, cloud metadata) unless you list an exception in CROW_BROWSER_ALLOW_PRIVATE. This is a rule inside Crow's tools, not a network wall: requests a page makes from its own background workers and some real-time connections are blocked only as far as possible, and a holder of the control key is not limited by it. When a bot's turn ends, Crow closes the pages that bot opened or used; the tabs you opened yourself stay open, and what you browse by hand in the viewer is not checked against this rule.",
  es: "Las propias herramientas de navegador de Crow rechazan las direcciones privadas y de red local (loopback, LAN, tailnet, link-local, metadatos de la nube) salvo que incluyas una excepción en CROW_BROWSER_ALLOW_PRIVATE. Es una regla dentro de las herramientas de Crow, no un muro de red: las solicitudes que una página hace desde sus propios procesos en segundo plano y algunas conexiones en tiempo real se bloquean solo en la medida de lo posible, y quien tenga la clave de control no está limitado por ella. Cuando termina el turno de un bot, Crow cierra las páginas que ese bot abrió o usó; las pestañas que abriste tú siguen abiertas, y lo que navegues a mano en el visor no se comprueba contra esta regla.",
};

const APPROVED_TURN_END = {
  en: "When a bot's turn ends, Crow sends each page that bot opened or used to a blank page, waits until it is blank, and then closes it, so nothing it opened keeps running and Back cannot bring it back. Tabs you opened yourself before the turn stay open with their history. To stay safe, Crow also closes: your tab whose popup the bot used (and that tab's other popups), a popup whose opener you had already closed, and any new tab that appears while a bot is working or within five seconds after. A bot's cookies and saved logins are kept.",
  es: "Cuando termina el turno de un bot, Crow lleva cada página que ese bot abrió o usó a una página en blanco, espera a que quede en blanco y luego la cierra, así que nada de lo que abrió sigue en marcha y el botón Atrás no puede recuperarlo. Las pestañas que abriste tú antes del turno siguen abiertas con su historial. Por seguridad, Crow también cierra: tu pestaña cuya ventana emergente usó el bot (y las demás ventanas emergentes de esa pestaña), una ventana emergente cuya pestaña de origen ya habías cerrado, y cualquier pestaña nueva que aparezca mientras un bot trabaja o en los cinco segundos siguientes. Las cookies y los inicios de sesión guardados del bot se conservan.",
};

/** The two guide files, and the old opening words that must be gone from each. */
const GUIDES = [
  { lang: "en", path: join(ROOT, "docs", "guide", "browser-automation.md"), gone: "The exit cleanup is worth knowing about" },
  { lang: "es", path: join(ROOT, "docs", "es", "guide", "browser-automation.md"), gone: "Conviene conocer la limpieza de salida" },
];

const read = (path) => readFileSync(path, "utf8");
const occurrences = (haystack, needle) => String(haystack).split(needle).length - 1;

/**
 * Every file under `dir`, skipping the usual non-source directories. The approved
 * marker text is a comment, not code, so nothing here needs to parse JavaScript.
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
    else if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) out.push(...walk(path));
  }
  return out;
}

describe("(a) the Fix-it card's COPY object carries the approved strings", () => {
  test("every field equals the approved EN and ES text", async () => {
    const { COPY } = await import("../servers/gateway/fix-it/detectors/browser-image-stale.js");
    assert.deepEqual(Object.keys(COPY).sort(), Object.keys(APPROVED).sort());
    for (const [field, langs] of Object.entries(APPROVED)) {
      for (const [lang, text] of Object.entries(langs)) {
        assert.equal(COPY[field][lang], text, `COPY.${field}.${lang} is the approved string`);
      }
    }
  });
});

describe("(b) the install consent message ends with the approved sentence", () => {
  const manifest = JSON.parse(read(join(ROOT, "bundles", "browser", "manifest.json")));

  for (const lang of ["en", "es"]) {
    test(`${lang}: the final sentence is the approved one, exactly once`, () => {
      const message = manifest.install_consent_messages?.[lang];
      assert.equal(typeof message, "string", `install_consent_messages.${lang} exists`);
      assert.ok(message.endsWith(APPROVED_CONSENT[lang]), `${lang} ends with the approved sentence`);
      assert.equal(occurrences(message, APPROVED_CONSENT[lang]), 1, `${lang} contains it exactly once`);
    });
  }
});

describe("(c) each guide carries the approved turn-end paragraph", () => {
  for (const { lang, path, gone } of GUIDES) {
    test(`${lang}: the paragraph is one whole line, and the old one is gone`, () => {
      const lines = read(path).split("\n");
      const hits = lines.filter((line) => line === APPROVED_TURN_END[lang]);
      assert.equal(hits.length, 1, `${lang} has the approved paragraph as a whole line`);
      assert.equal(occurrences(read(path), gone), 0, `${lang} no longer carries the old wording`);
    });
  }
});

describe("(d) the approval marker is gone from the card code", () => {
  test("no file under servers/gateway/fix-it says the copy is pending approval", () => {
    const marker = "PENDING OPERATOR APPROVAL";
    const files = walk(join(ROOT, "servers", "gateway", "fix-it"));
    assert.ok(files.length > 0, "the fix-it tree was walked");
    const offenders = files.filter((path) => read(path).includes(marker));
    assert.deepEqual(offenders, [], "the pending-approval marker is replaced by the approval date");
  });
});