/** Keep in sync with src/ttsSanitize.js */

function stripSurrogates(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          result += str[i] + str[i + 1];
          i++;
          continue;
        }
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    result += str[i];
  }
  return result;
}

function toUtf8Safe(str) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(encoder.encode(str));
}

function sanitizeForTTS(text) {
  if (text == null) return "";

  let out = stripSurrogates(String(text));
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  out = out.replace(/\u00A0/g, " ");
  out = out
    .replace(/[\u2018\u2019\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");

  try {
    out = out.normalize("NFKC");
    out = stripSurrogates(out);
  } catch {
    /* ignore */
  }

  out = toUtf8Safe(out);
  return out.trim();
}

function splitTextForTTS(text, maxChars = 500) {
  const cleaned = sanitizeForTTS(text);
  if (!cleaned) return [];

  const sentences = cleaned.split(/(?<=[.!?])\s+|\n+/);
  const chunks = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;

    if (piece.length > maxChars) {
      flush();
      for (let i = 0; i < piece.length; i += maxChars) {
        const slice = sanitizeForTTS(piece.slice(i, i + maxChars));
        if (slice) chunks.push(slice);
      }
      continue;
    }

    const candidate = buf ? `${buf} ${piece}` : piece;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      flush();
      buf = piece;
    }
  }

  flush();
  return chunks.map((c) => sanitizeForTTS(c)).filter(Boolean);
}

module.exports = { sanitizeForTTS, splitTextForTTS, stripSurrogates };
