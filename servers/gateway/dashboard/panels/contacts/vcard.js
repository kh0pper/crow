/**
 * Contacts Panel — vCard & CSV Parsing/Generation
 *
 * Pure JS vCard 3.0 parser/generator. No external dependencies.
 * Also handles simple CSV import (first row = headers).
 */

/**
 * Parse vCard 3.0 text into an array of contact objects.
 * Handles FN, N, EMAIL, TEL, NOTE, ORG fields.
 * Supports multi-contact files (multiple BEGIN:VCARD blocks).
 * @param {string} content - Raw vCard text
 * @returns {{ name: string, email: string, phone: string, notes: string }[]}
 */
export function parseVCard(content) {
  if (!content || typeof content !== "string") return [];

  const contacts = [];
  const blocks = content.split(/BEGIN:VCARD/i).slice(1);

  for (const block of blocks) {
    const endIdx = block.search(/END:VCARD/i);
    const body = endIdx >= 0 ? block.substring(0, endIdx) : block;

    // Unfold continuation lines (RFC 2425 line folding)
    const unfolded = body.replace(/\r?\n[ \t]/g, "");
    const lines = unfolded.split(/\r?\n/).filter(Boolean);

    const contact = { name: "", email: "", phone: "", notes: "" };

    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;

      const rawKey = line.substring(0, colonIdx).toUpperCase();
      const value = line.substring(colonIdx + 1).trim();

      // Strip parameters (e.g., "TEL;TYPE=WORK" -> "TEL")
      const key = rawKey.split(";")[0];

      if (key === "FN" && value) {
        contact.name = value;
      } else if (key === "N" && !contact.name && value) {
        // N format: LastName;FirstName;MiddleName;Prefix;Suffix
        const parts = value.split(";");
        const first = (parts[1] || "").trim();
        const last = (parts[0] || "").trim();
        contact.name = [first, last].filter(Boolean).join(" ");
      } else if (key === "EMAIL" && value) {
        contact.email = contact.email ? contact.email : value;
      } else if (key === "TEL" && value) {
        contact.phone = contact.phone ? contact.phone : value;
      } else if (key === "NOTE" && value) {
        contact.notes = contact.notes ? contact.notes + "\n" + value : value;
      }
    }

    if (contact.name || contact.email || contact.phone) {
      contacts.push(contact);
    }
  }

  return contacts;
}

/**
 * Generate vCard 3.0 text from an array of contacts.
 * @param {{ display_name?: string, name?: string, email?: string, phone?: string, notes?: string, bio?: string }[]} contacts
 * @returns {string}
 */
export function generateVCard(contacts) {
  if (!contacts || !Array.isArray(contacts)) return "";

  const cards = contacts.map((c) => {
    const name = c.display_name || c.name || "Unknown";
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${name}`,
    ];

    // N field: try to split name into parts
    const nameParts = name.split(/\s+/);
    if (nameParts.length >= 2) {
      lines.push(`N:${nameParts.slice(1).join(" ")};${nameParts[0]};;;`);
    } else {
      lines.push(`N:${name};;;;`);
    }

    if (c.email) lines.push(`EMAIL:${c.email}`);
    if (c.phone) lines.push(`TEL:${c.phone}`);
    if (c.notes || c.bio) lines.push(`NOTE:${(c.notes || c.bio || "").replace(/\n/g, "\\n")}`);

    lines.push("END:VCARD");
    return lines.join("\r\n");
  });

  return cards.join("\r\n");
}

/**
 * Parse CSV content (first row = headers) into contacts array.
 * Recognizes common header names: name, email, phone, notes.
 * @param {string} content
 * @returns {{ name: string, email: string, phone: string, notes: string }[]}
 */
export function parseCsv(content) {
  if (!content || typeof content !== "string") return [];

  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ""));

  // Map common header names
  const nameIdx = headers.findIndex((h) => /^(name|full.?name|display.?name|fn)$/i.test(h));
  const emailIdx = headers.findIndex((h) => /^(email|e.?mail|email.?address)$/i.test(h));
  const phoneIdx = headers.findIndex((h) => /^(phone|tel|telephone|mobile|cell)$/i.test(h));
  const notesIdx = headers.findIndex((h) => /^(notes?|comment|description)$/i.test(h));

  const contacts = [];

  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse (does not handle quoted commas inside fields)
    const fields = lines[i].split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));

    const contact = {
      name: nameIdx >= 0 ? (fields[nameIdx] || "") : "",
      email: emailIdx >= 0 ? (fields[emailIdx] || "") : "",
      phone: phoneIdx >= 0 ? (fields[phoneIdx] || "") : "",
      notes: notesIdx >= 0 ? (fields[notesIdx] || "") : "",
    };

    if (contact.name || contact.email || contact.phone) {
      contacts.push(contact);
    }
  }

  return contacts;
}
