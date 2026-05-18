import React, { useState, useEffect, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { sanitizeForTTS, splitTextForTTS } from "./ttsSanitize";

// Set workerSrc for pdfjs (explicit https for production / strict CSP)
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.mjs`;

const API_BASE = (process.env.REACT_APP_API_BASE_URL || "http://localhost:8000/api").replace(
  /\/$/,
  ""
);
const hasDesktopTTS = typeof window !== "undefined" && !!window.desktopTTS?.speak;

export default function PdfViewer({ fileUrl }) {
  const [numPages, setNumPages] = useState(null);
  const [isReading, setIsReading] = useState(false);
  const [, setCurrentReadingPosition] = useState(null);
  const [theme, setTheme] = useState("dark");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState(1);
  const [readingStatus, setReadingStatus] = useState("");

  const isReadingRef = useRef(isReading);
  const readCursorRef = useRef(null);
  const preparedQueue = useRef([]);
  const prefetchPromise = useRef(null);
  const chunkIndexRef = useRef(0);
  const readingSessionIdRef = useRef(null);
  const spokenFingerprintsRef = useRef([]);

  const MIN_CHARS_PER_CHUNK = 400;
  const MIN_CHARS_FOR_GPT = 200;
  const MAX_CHARS_PER_CHUNK = 2800;
  const MAX_GPT_EXPANSION_RATIO = 2.2;

  // Piper/audio playback refs
  const audioRef = useRef(null);
  const ttsAbortRef = useRef(null);
  const audioObjectUrlRef = useRef(null);

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  // Initialize a single Audio instance
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.preload = "auto";

    return () => {
      try {
        if (ttsAbortRef.current) ttsAbortRef.current.abort();
      } catch {}
      try {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.src = "";
        }
      } catch {}
      try {
        if (audioObjectUrlRef.current) {
          URL.revokeObjectURL(audioObjectUrlRef.current);
          audioObjectUrlRef.current = null;
        }
      } catch {}
      audioRef.current = null;
    };
  }, []);

  function getNextSpanGlobal(anchorSpan) {
    if (!anchorSpan) return null;

    const currentPage = anchorSpan.closest(".react-pdf__Page");
    if (!currentPage) return null;

    const currentTextLayer = currentPage.querySelector(".react-pdf__Page__textContent");
    const currentSpans = Array.from(currentTextLayer?.querySelectorAll("span") || []);
    const currentIndex = currentSpans.indexOf(anchorSpan);

    if (currentIndex >= 0 && currentIndex + 1 < currentSpans.length) {
      return currentSpans[currentIndex + 1];
    }

    let nextPage = currentPage.nextElementSibling;
    while (nextPage) {
      const nextTextLayer = nextPage.querySelector(".react-pdf__Page__textContent");
      if (nextTextLayer) {
        const nextSpans = Array.from(nextTextLayer.querySelectorAll("span"));
        const firstMeaningfulSpan = nextSpans.find((span) => span.textContent.trim().length > 0);
        if (firstMeaningfulSpan) return firstMeaningfulSpan;
      }
      nextPage = nextPage.nextElementSibling;
    }

    return null;
  }

  function isEndOfParagraph(spanElement) {
    if (!spanElement) return false;

    const rect = spanElement.getBoundingClientRect();
    const nextSpan = getNextSpanGlobal(spanElement);
    if (!nextSpan) return false;

    const nextRect = nextSpan.getBoundingClientRect();
    const nextText = nextSpan.textContent.trim();

    const verticalGap = nextRect.top - rect.bottom;
    if (verticalGap > rect.height * 1.5) return true;

    const currentPage = spanElement.closest(".react-pdf__Page");
    const pageRect = currentPage?.getBoundingClientRect();
    if (pageRect) {
      const currentLeftMargin = rect.left - pageRect.left;
      const nextLeftMargin = nextRect.left - pageRect.left;
      if (nextLeftMargin > currentLeftMargin + 20) return true;
    }

    const paragraphStarters = [
      /^[A-Z][a-z]+:/,
      /^\d+\./,
      /^[A-Z][A-Z\s]+$/,
      /^[A-Z][a-z]+\s+[A-Z][a-z]+:/,
    ];

    for (const pattern of paragraphStarters) {
      if (pattern.test(nextText)) return true;
    }

    return false;
  }

  function isSpanConsumed(span) {
    return !!span?.dataset?.ttsRead;
  }

  function markSpansConsumed(spanElements) {
    for (const el of spanElements) {
      if (el) el.dataset.ttsRead = "1";
    }
  }

  function clearConsumedSpanMarks() {
    document.querySelectorAll(".react-pdf__Page__textContent span[data-tts-read]").forEach((span) => {
      delete span.dataset.ttsRead;
    });
  }

  function normalizeForDedup(text) {
    return sanitizeForTTS(text).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function getTextOverlapScore(a, b) {
    if (!a || !b) return 0;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length < 40) return 0;
    if (longer.includes(shorter)) {
      return shorter.length / longer.length;
    }
    const windowSize = Math.min(200, shorter.length);
    let best = 0;
    for (let i = 0; i + 40 <= shorter.length; i += Math.max(40, Math.floor(windowSize / 2))) {
      const probe = shorter.slice(i, i + windowSize);
      if (probe.length >= 40 && longer.includes(probe)) {
        best = Math.max(best, probe.length / shorter.length);
      }
    }
    return best;
  }

  function isMostlyDuplicate(norm) {
    if (!norm || norm.length < 80) return false;
    for (const prior of spokenFingerprintsRef.current) {
      if (getTextOverlapScore(norm, prior) >= 0.65) return true;
    }
    return false;
  }

  function recordSpokenFingerprint(norm) {
    if (!norm || norm.length < 40) return;
    spokenFingerprintsRef.current.push(norm);
    if (spokenFingerprintsRef.current.length > 6) {
      spokenFingerprintsRef.current.shift();
    }
  }

  /** PDF.js often exposes the same passage as different span trees; mark all overlapping spans. */
  function markOverlappingSpansInDocument(chunkNorm) {
    if (!chunkNorm || chunkNorm.length < 40) return;

    const probes = [];
    const len = chunkNorm.length;
    for (const start of [0, Math.floor(len / 3), Math.floor((2 * len) / 3)]) {
      const probe = chunkNorm.slice(start, start + 120);
      if (probe.length >= 30) probes.push(probe);
    }

    document.querySelectorAll(".react-pdf__Page__textContent span").forEach((span) => {
      if (span.dataset.ttsRead) return;
      const t = normalizeForDedup(span.textContent);
      if (t.length < 10) return;
      if (t.length >= 12 && chunkNorm.includes(t)) {
        span.dataset.ttsRead = "1";
        return;
      }
      for (const probe of probes) {
        if ((t.length >= 20 && t.includes(probe)) || (probe.length >= 30 && chunkNorm.includes(t))) {
          span.dataset.ttsRead = "1";
          return;
        }
      }
    });
  }

  function skipConsumedSpans(span) {
    let current = span;
    while (current && isSpanConsumed(current)) {
      current = getNextSpanGlobal(current);
    }
    return current;
  }

  function looksLikeHeadingOnly(text) {
    const t = (text || "").trim();
    if (t.length > 120) return false;
    return /^[A-Z0-9][A-Za-z0-9\s:'",-]{0,120}$/.test(t) && !/[.!?]/.test(t);
  }

  function collectTextChunks(startSpan, options = {}) {
    const minChars = options.minChars ?? MIN_CHARS_PER_CHUNK;
    const maxChars = options.maxChars ?? MAX_CHARS_PER_CHUNK;
    const maxParagraphs = options.maxParagraphs ?? 8;

    let currentSpan = skipConsumedSpans(startSpan);
    if (!currentSpan) {
      return { chunks: [], nextSpan: null, combinedLength: 0 };
    }

    const chunks = [];
    let paragraphCount = 0;
    let currentChunk = [];
    let totalChars = 0;

    const flushCurrentChunk = () => {
      if (currentChunk.length === 0) return;
      const rawText = currentChunk.map((s) => s.text).join(" ");
      chunks.push({
        spans: [...currentChunk],
        rawText,
        paragraphNumber: paragraphCount + 1,
      });
      totalChars += rawText.length + 2;
      currentChunk = [];
      paragraphCount++;
    };

    while (
      currentSpan &&
      totalChars < maxChars &&
      (totalChars < minChars || paragraphCount < maxParagraphs)
    ) {
      if (isSpanConsumed(currentSpan)) {
        currentSpan = getNextSpanGlobal(currentSpan);
        continue;
      }

      const text = currentSpan.textContent.trim();
      if (text.length > 0) {
        currentChunk.push({ element: currentSpan, text });

        if (isEndOfParagraph(currentSpan)) {
          flushCurrentChunk();
          if (totalChars >= minChars) {
            currentSpan = getNextSpanGlobal(currentSpan);
            break;
          }
        }
      }

      currentSpan = getNextSpanGlobal(currentSpan);
    }

    if (currentChunk.length > 0 && totalChars < maxChars) {
      flushCurrentChunk();
    }

    const chunkItems = chunks.flatMap((c) => c.spans);
    const lastElement = chunkItems.length > 0 ? chunkItems[chunkItems.length - 1].element : null;
    const nextSpan = skipConsumedSpans(
      lastElement ? getNextSpanGlobal(lastElement) : null
    );

    return { chunks, nextSpan, combinedLength: totalChars };
  }

  async function sendToChatGPT(text, { chunkIndex = 0, sessionId = "default" } = {}) {
    const charCount = (text || "").length;
    console.log(`[Reading ${sessionId}] Chunk ${chunkIndex}: sending ${charCount} chars to ChatGPT`);
    try {
      const response = await fetch(`${API_BASE}/chatgpt/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Clean and format the following excerpt for text-to-speech. Fix spacing and line breaks only. Rules: do NOT add new sentences; do NOT invent or continue the passage; do NOT summarize; if the input is only a title or heading, return only that title. Return the same content, cleaned for reading aloud:\n\n${text}`,
          max_tokens: 1000,
          chunk_index: chunkIndex,
          session_id: sessionId,
          char_count: charCount,
        }),
      });

      const data = await response.json();

      if (data.choices && data.choices.length > 0) {
        const cleaned = data.choices[0].message.content.trim();
        console.log(
          `[Reading ${sessionId}] Chunk ${chunkIndex}: ChatGPT returned ${cleaned.length} chars`
        );
        console.log("===== ChatGPT CLEANED TEXT (what Piper will speak) =====");
        console.log(cleaned);
        console.log("========================================================");
        return cleaned;
      }

      console.error("Unexpected response from ChatGPT API:", data);
      return null;
    } catch (error) {
      console.error("Error sending request to Django API:", error);
      return null;
    }
  }

  async function synthesizeSpeech(text) {
    const segments = splitTextForTTS(text, 500);
    if (segments.length === 0) {
      throw new Error("No text provided for TTS.");
    }

    const blobs = [];

    if (hasDesktopTTS) {
      for (let i = 0; i < segments.length; i++) {
        try {
          const result = await window.desktopTTS.speak(segments[i]);
          const buffers = Array.isArray(result) ? result : [result];
          for (const wavBytes of buffers) {
            blobs.push(new Blob([wavBytes], { type: "audio/wav" }));
          }
        } catch (err) {
          console.warn(
            `[Reading] TTS segment ${i + 1}/${segments.length} skipped:`,
            err.message || err
          );
        }
      }
    } else {
      for (let i = 0; i < segments.length; i++) {
        try {
          const res = await fetch(`${API_BASE}/tts/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: segments[i] }),
          });
          if (!res.ok) {
            throw new Error(`TTS failed (${res.status})`);
          }
          blobs.push(await res.blob());
        } catch (err) {
          console.warn(
            `[Reading] TTS segment ${i + 1}/${segments.length} skipped:`,
            err.message || err
          );
        }
      }
    }

    if (blobs.length === 0) {
      throw new Error("TTS failed for all segments.");
    }

    return blobs;
  }

  async function playAudioBlob(blob) {
    if (!blob || !audioRef.current) return;

    try {
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
    } catch {}
    ttsAbortRef.current = null;

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }

    const url = URL.createObjectURL(blob);
    audioObjectUrlRef.current = url;

    await new Promise((resolve, reject) => {
      const audio = audioRef.current;
      if (!audio) return resolve();

      const onEnded = () => cleanup(resolve);
      const onError = (e) => cleanup(() => reject(e));

      const cleanup = (cb) => {
        try {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
        } catch {}
        cb();
      };

      try {
        audio.src = url;
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch((e) => cleanup(() => reject(e)));
        }
      } catch (e) {
        cleanup(() => reject(e));
      }
    });
  }

  function stopAudioNow() {
    try {
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
    } catch {}

    try {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
        audio.src = "";
      }
    } catch {}

    try {
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
        audioObjectUrlRef.current = null;
      }
    } catch {}
  }

  async function buildChunkFromSpan(startSpan, chunkIndex, sessionId) {
    let cursor = startSpan;
    let chunks;
    let nextSpan;
    let combinedLength;
    let chunkItems;
    let accepted = false;

    for (let attempt = 0; attempt < 8; attempt++) {
      ({ chunks, nextSpan, combinedLength } = collectTextChunks(cursor));
      if (chunks.length === 0) return null;

      chunkItems = chunks.flatMap((c) =>
        c.spans.map((s) => ({ element: s.element, text: s.text }))
      );
      if (chunkItems.length === 0) return null;

      const combinedText = sanitizeForTTS(chunks.map((c) => c.rawText).join("\n\n"));
      const norm = normalizeForDedup(combinedText);

      if (norm.length >= 80 && isMostlyDuplicate(norm)) {
        console.log(
          `[Reading ${sessionId}] Chunk ${chunkIndex}: skipping duplicate text (${norm.length} chars), advancing cursor`
        );
        markSpansConsumed(chunkItems.map((item) => item.element));
        markOverlappingSpansInDocument(norm);
        cursor = nextSpan;
        if (!cursor) return null;
        continue;
      }

      markSpansConsumed(chunkItems.map((item) => item.element));
      markOverlappingSpansInDocument(norm);
      recordSpokenFingerprint(norm);
      accepted = true;
      break;
    }

    if (!accepted || !chunks?.length || !chunkItems?.length) {
      console.warn(
        `[Reading ${sessionId}] Chunk ${chunkIndex}: no new text after duplicate skips`
      );
      return null;
    }

    const combinedText = sanitizeForTTS(chunks.map((c) => c.rawText).join("\n\n"));
    let cleanedText = combinedText;

    const canUseGpt =
      combinedText.length >= MIN_CHARS_FOR_GPT && !looksLikeHeadingOnly(combinedText);

    if (canUseGpt) {
      const gptResult = await sendToChatGPT(combinedText, { chunkIndex, sessionId });
      if (gptResult) {
        const maxAllowed = Math.max(
          combinedText.length * MAX_GPT_EXPANSION_RATIO,
          combinedText.length + 150
        );
        if (gptResult.length <= maxAllowed) {
          cleanedText = sanitizeForTTS(gptResult);
        } else {
          console.warn(
            `[Reading ${sessionId}] Chunk ${chunkIndex}: ChatGPT expanded ${combinedText.length} -> ${gptResult.length} chars; using raw PDF text`
          );
        }
      } else {
        console.warn(
          `[Reading ${sessionId}] Chunk ${chunkIndex}: using raw PDF text (ChatGPT unavailable)`
        );
      }
    } else {
      console.log(
        `[Reading ${sessionId}] Chunk ${chunkIndex}: skipping ChatGPT (${combinedLength} chars from PDF, heading-only or too short)`
      );
    }

    if (!cleanedText) {
      throw new Error("No speakable text after cleanup");
    }

    console.log(
      `[Reading ${sessionId}] Chunk ${chunkIndex}: synthesizing ${cleanedText.length} chars`
    );
    const audioBlobs = await synthesizeSpeech(cleanedText);
    if (!audioBlobs.length) {
      throw new Error("TTS produced no audio");
    }

    return { audioBlobs, chunkItems, cleanedText, chunkIndex, nextSpan };
  }

  async function ensurePrefetch() {
    if (prefetchPromise.current) {
      return prefetchPromise.current;
    }
    if (!readCursorRef.current || !isReadingRef.current) {
      return null;
    }

    const startSpan = readCursorRef.current;
    const chunkIndex = chunkIndexRef.current;
    const sessionId = readingSessionIdRef.current || "default";

    prefetchPromise.current = (async () => {
      try {
        const chunk = await buildChunkFromSpan(startSpan, chunkIndex, sessionId);
        if (chunk) {
          readCursorRef.current = chunk.nextSpan;
          chunkIndexRef.current += 1;
          preparedQueue.current.push(chunk);
          setReadingStatus(
            `Chunk ${chunkIndex} ready · ${preparedQueue.current.length} in queue`
          );
          console.log(
            `[Reading ${sessionId}] Chunk ${chunkIndex} ready (queue: ${preparedQueue.current.length})`
          );
        }
        return chunk;
      } catch (error) {
        console.error(`[Reading ${sessionId}] Chunk ${chunkIndex} prepare failed:`, error);
        const skip = collectTextChunks(startSpan, {
          minChars: 80,
          maxChars: 400,
          maxParagraphs: 2,
        });
        if (skip.chunks?.length) {
          markSpansConsumed(
            skip.chunks.flatMap((c) => c.spans.map((s) => s.element))
          );
        }
        readCursorRef.current = skip.nextSpan || getNextSpanGlobal(startSpan);
        chunkIndexRef.current += 1;
        return null;
      } finally {
        prefetchPromise.current = null;
      }
    })();

    return prefetchPromise.current;
  }

  async function startReadingFromPosition(anchorSpan) {
    if (!anchorSpan) return;

    readingSessionIdRef.current = `read-${Date.now()}`;
    chunkIndexRef.current = 0;
    readCursorRef.current = anchorSpan;
    preparedQueue.current = [];
    prefetchPromise.current = null;
    spokenFingerprintsRef.current = [];
    clearConsumedSpanMarks();

    setIsReading(true);
    isReadingRef.current = true;
    setCurrentReadingPosition(anchorSpan);

    console.log(`[Reading ${readingSessionIdRef.current}] Started from selection`);
    await ensurePrefetch();
    startReadingLoop();
  }

  async function startReadingLoop() {
    const sessionId = readingSessionIdRef.current || "default";

    try {
      while (isReadingRef.current) {
        while (preparedQueue.current.length === 0 && isReadingRef.current) {
          const chunk = await ensurePrefetch();
          if (!chunk) {
            break;
          }
        }

        if (!isReadingRef.current || preparedQueue.current.length === 0) {
          break;
        }

        const nextPrefetch = ensurePrefetch();
        const { audioBlobs, chunkItems, chunkIndex } = preparedQueue.current.shift();

        chunkItems.forEach((item) => highlightSpan(item.element));
        setReadingStatus(
          `Playing chunk ${chunkIndex} · ${preparedQueue.current.length} prepared ahead`
        );
        console.log(
          `[Reading ${sessionId}] Playing chunk ${chunkIndex} (${audioBlobs.length} segment(s), ${chunkItems.length} spans)`
        );

        try {
          for (let s = 0; s < audioBlobs.length && isReadingRef.current; s++) {
            await playAudioBlob(audioBlobs[s]);
          }
        } catch (e) {
          console.error(`[Reading ${sessionId}] Playback error on chunk ${chunkIndex}:`, e);
        } finally {
          chunkItems.forEach((item) => removeHighlight(item.element));
        }

        await nextPrefetch.catch(() => {});
      }
    } finally {
      setIsReading(false);
      isReadingRef.current = false;
      preparedQueue.current = [];
      prefetchPromise.current = null;
      readCursorRef.current = null;
      setReadingStatus("");
      console.log(`[Reading ${sessionId}] Finished`);
    }
  }

 function highlightSpan(spanElement) {
  if (!spanElement) return;
  spanElement.classList.add("tts-highlight");
}

function removeHighlight(spanElement) {
  if (!spanElement) return;
  spanElement.classList.remove("tts-highlight");
}


  function stopReading() {
    isReadingRef.current = false;
    setIsReading(false);

    preparedQueue.current = [];
    prefetchPromise.current = null;
    readCursorRef.current = null;
    spokenFingerprintsRef.current = [];
    stopAudioNow();
    clearConsumedSpanMarks();

    document.querySelectorAll(".react-pdf__Page__textContent span").forEach((span) => {
      removeHighlight(span);
    });
  }

  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (selection && selection.toString().trim()) {
        console.log("Selected text:", selection.toString());
      }

      let anchorNode = selection.anchorNode;
      if (anchorNode && anchorNode.nodeType === Node.TEXT_NODE) {
        anchorNode = anchorNode.parentElement;
        console.log("Anchor node:", anchorNode);
      }

      if (anchorNode && anchorNode.tagName === "SPAN" && !isReading) {
        startReadingFromPosition(anchorNode);
      }
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
    };
    // startReadingFromPosition is recreated each render; listing it would rebind the listener every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only rebind when isReading toggles
  }, [isReading]);

  useEffect(() => {
    isReadingRef.current = isReading;
  }, [isReading]);

  useEffect(() => {
    document.body.className = theme + "-mode";
    document.documentElement.className = theme + "-mode";
  }, [theme]);

  function onPageRender(pageNumber) {
    setCurrentPage(pageNumber);
  }

  function handleScroll(e) {
    const container = e.target;
    const pages = container.querySelectorAll(".react-pdf__Page");
    let found = false;

    for (let i = 0; i < pages.length; i++) {
      const rect = pages[i].getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (rect.bottom > containerRect.top + 50) {
        setCurrentPage(i + 1);
        found = true;
        break;
      }
    }

    if (!found && pages.length > 0) {
      setCurrentPage(pages.length);
    }
  }

  useEffect(() => {
    const container = document.querySelector(".pdf-container");
    if (container) {
      container.addEventListener("scroll", handleScroll);
      return () => container.removeEventListener("scroll", handleScroll);
    }
  }, [numPages]);

  function goToPage(pageNum) {
    const container = document.querySelector(".pdf-container");
    const pages = container?.querySelectorAll(".react-pdf__Page");
    if (pages && pages.length > 0 && pageNum >= 1 && pageNum <= pages.length) {
      const pageElem = pages[pageNum - 1];
      if (pageElem && pageElem.scrollIntoView) {
        pageElem.scrollIntoView({ behavior: "smooth", block: "start" });
        setCurrentPage(pageNum);
        setPageInput(pageNum);
      }
    }
  }

  useEffect(() => {
    setPageInput(currentPage);
  }, [currentPage]);

  function handleInputChange(e) {
    const val = e.target.value.replace(/[^0-9]/g, "");
    setPageInput(val ? parseInt(val) : "");
  }

  function handleGo(e) {
    e.preventDefault();
    if (pageInput >= 1 && pageInput <= numPages) {
      goToPage(pageInput);
    }
  }

  return  (
    <div className={theme === "dark" ? "dark-mode" : "light-mode"}>

      <style>{`
        .tts-highlight {
          background: yellow !important;
          color: black !important;
        }
      `}</style>

      <div style={{ marginBottom: "10px" }}>
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          style={{
            padding: "8px 16px",
            backgroundColor: theme === "dark" ? "#333" : "#eee",
            color: theme === "dark" ? "#fff" : "#222",
            border: "none",
            borderRadius: "4px",
            marginRight: "10px",
            cursor: "pointer",
          }}
        >
          Switch to {theme === "dark" ? "Light" : "Dark"} Mode
        </button>

        <button
          onClick={stopReading}
          disabled={!isReading}
          style={{
            padding: "8px 16px",
            backgroundColor: isReading ? "#ff4444" : "#ccc",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: isReading ? "pointer" : "not-allowed",
          }}
        >
          {isReading ? "Stop Reading" : "Not Reading"}
        </button>

        {isReading && readingStatus && (
          <span style={{ marginLeft: "10px", color: "#666" }}>{readingStatus}</span>
        )}
      </div>

      <div className="pdf-container">
        <form className="page-overlay" onSubmit={handleGo}>
          <label htmlFor="page-input" style={{ marginRight: 8 }}>
            Page
          </label>
          <input
            id="page-input"
            type="number"
            min={1}
            max={numPages || 1}
            value={pageInput}
            onChange={handleInputChange}
            style={{
              width: 60,
              padding: "4px 8px",
              borderRadius: 8,
              border: "1px solid #888",
              marginRight: 8,
              fontSize: "1rem",
              textAlign: "center",
              background: "rgba(255,255,255,0.9)",
            }}
          />
          <span style={{ marginRight: 8 }}>/ {numPages || 1}</span>
          <button
            type="submit"
            style={{
              padding: "4px 12px",
              borderRadius: 8,
              border: "none",
              background: "#444",
              color: "#fff",
              fontWeight: "bold",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Go
          </button>
        </form>

        <Document file={fileUrl} onLoadSuccess={onDocumentLoadSuccess}>
          {Array.from(new Array(numPages), (el, index) => (
            <Page
              key={`page_${index + 1}`}
              pageNumber={index + 1}
              renderAnnotationLayer={false}
              onRenderSuccess={() => onPageRender(index + 1)}
            />
          ))}
        </Document>
      </div>
    </div>
  );
}
