import React, { useState, useEffect, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// Set workerSrc for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.mjs`;

const API_BASE = "http://localhost:8000/api";

export default function PdfViewer({ fileUrl }) {
  const [numPages, setNumPages] = useState(null);
  const [isReading, setIsReading] = useState(false);
  const [currentReadingPosition, setCurrentReadingPosition] = useState(null);
  const [theme, setTheme] = useState("dark");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState(1);

  // Buffer management for continuous reading
  
  const bufferSize = 10;
  const isLoadingMore = useRef(false);
  
  const isReadingRef = useRef(isReading);

const currentChunkRef = useRef(null);
const nextChunkPromiseRef = useRef(null);
const preparedChunksRef = useRef(new Map());

  // Piper/audio playback refs
  const audioRef = useRef(null);
  const ttsAbortRef = useRef(null);
  const audioObjectUrlRef = useRef(null);

  const DEBUG_TTS = true;
  const dbg = (...args) => DEBUG_TTS && console.log(...args);

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  function splitIntoSentences(text) {
  const t = (text || "").trim();
  if (!t) return [];

  // Best option: Intl.Segmenter (modern browsers)
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(seg.segment(t))
      .map(s => s.segment.trim())
      .filter(Boolean);
  }

  // Fallback (simple, decent)
  const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return parts.map(s => s.trim()).filter(Boolean);
}

function buildRawTextAndSpanRanges(spans) {
  // rawText MUST match how you combined it earlier: join with spaces
  let rawText = "";
  const ranges = [];

  for (let i = 0; i < spans.length; i++) {
    const piece = (spans[i]?.text || "").trim();
    if (!piece) continue;

    const prefix = rawText.length === 0 ? "" : " ";
    const start = rawText.length + prefix.length;
    rawText += prefix + piece;
    const end = rawText.length; // end is exclusive
    ranges.push({ element: spans[i].element, start, end });
  }

  return { rawText, ranges };
}

function sentenceOffsets(text) {
  const t = (text || "");
  if (!t) return [];

  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    return Array.from(seg.segment(t))
      .map(s => ({ start: s.index, end: s.index + s.segment.length, text: s.segment }))
      .filter(s => s.text.trim().length > 0);
  }

  // Fallback offsets (approx)
  const parts = splitIntoSentences(t);
  let cursor = 0;
  return parts.map(p => {
    const start = t.indexOf(p, cursor);
    const end = start + p.length;
    cursor = end;
    return { start, end, text: p };
  });
}

function buildSentenceSpanGroups(rawText, spanRanges) {
  const offsets = sentenceOffsets(rawText);
  if (offsets.length === 0) return [];

  return offsets.map(({ start, end }) => {
    // spans whose ranges overlap this sentence range
    const group = spanRanges
      .filter(r => r.end > start && r.start < end)
      .map(r => r.element);

    return group;
  });
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

  function getSpansFromPosition(startSpan, count = bufferSize) {
    const spans = [];
    let currentSpan = startSpan;

    for (let i = 0; i < count && currentSpan; i++) {
      const text = currentSpan.textContent.trim();
      if (text.length > 0) {
        spans.push({
          element: currentSpan,
          text,
          index: i,
        });
      }
      currentSpan = getNextSpanGlobal(currentSpan);
    }

    return spans;
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

  function collectTextChunks(startSpan, maxParagraphs = 5) {
    const chunks = [];
    let currentSpan = startSpan;
    let paragraphCount = 0;
    let currentChunk = [];

    while (currentSpan && paragraphCount < maxParagraphs) {
      const text = currentSpan.textContent.trim();

      if (text.length > 0) {
        currentChunk.push({
          element: currentSpan,
          text,
        });

        if (isEndOfParagraph(currentSpan)) {
          if (currentChunk.length > 0) {
            chunks.push({
              spans: [...currentChunk],
              rawText: currentChunk.map((s) => s.text).join(" "),
              paragraphNumber: paragraphCount + 1,
            });
            currentChunk = [];
            paragraphCount++;
          }
        }
      }

      currentSpan = getNextSpanGlobal(currentSpan);
    }

    if (currentChunk.length > 0) {
      chunks.push({
        spans: currentChunk,
        rawText: currentChunk.map((s) => s.text).join(" "),
        paragraphNumber: paragraphCount + 1,
      });
    }

    return chunks;
  }

  function collectChunkFromStartSpan(startSpan, maxParagraphs = 5) {
  const chunks = collectTextChunks(startSpan, maxParagraphs);
  const allChunkSpans = chunks.flatMap(c => c.spans);
  if (!allChunkSpans.length) return null;

  const { rawText, ranges } = buildRawTextAndSpanRanges(allChunkSpans);
  const rawSentenceSpanGroups = buildSentenceSpanGroups(rawText, ranges);

  return {
    startElement: allChunkSpans[0].element,
    endElement: allChunkSpans[allChunkSpans.length - 1].element,
    spans: allChunkSpans,
    rawText,
    rawSentenceSpanGroups,
    chunkSize: allChunkSpans.length,
  };
}

async function prepareChunkForPlayback(chunk) {
  let cleanedText = chunk.rawText;
  try {
    cleanedText = await sendToChatGPT(chunk.rawText);
  } catch {
    cleanedText = chunk.rawText;
  }

  const cleanedSentences = splitIntoSentences(cleanedText);

  return {
    ...chunk,
    cleanedText,
    cleanedSentences,
    chunkId: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
  };
}

async function buildChunkFromAnchor(anchorSpan) {
  if (!anchorSpan) return null;

  const rawChunk = collectChunkFromStartSpan(anchorSpan, 5);
  if (!rawChunk) return null;

  const preparedChunk = await prepareChunkForPlayback(rawChunk);

  const controller = new AbortController();
  preparedChunk.abortController = controller;
  preparedChunk.audioPromise = prefetchChunkAudios(preparedChunk, controller.signal);

  return preparedChunk;
}

async function buildAndPrefetchNextChunk(fromChunk) {
  const lastSpan = fromChunk?.endElement;
  if (!lastSpan) return null;

  const nextSpan = getNextSpanGlobal(lastSpan);
  if (!nextSpan) return null;

  return await buildChunkFromAnchor(nextSpan);
}

  async function sendToChatGPT(text) {
    console.log("Sending text to ChatGPT:", text);
    try {
      const response = await fetch(`${API_BASE}/chatgpt/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Clean and format this text for text-to-speech reading. Make it flow naturally and fix any formatting issues. Do not, I repeat do not change the content of the text. Print it back as is but with no formatting issues and with no things like page numbers and stuff that cuts the flow of the ideas.: \n\n${text}`,
          max_tokens: 1000,
        }),
      });

      const data = await response.json();

    if (data.choices && data.choices.length > 0) {
      const cleaned = data.choices[0].message.content.trim();

      console.log("===== ChatGPT CLEANED TEXT (what Piper will speak) =====");
      console.log(cleaned);
      console.log("========================================================");

      return cleaned;
    }

      console.error("Unexpected response from ChatGPT API:", data);
      return "[Error] Could not process text";
    } catch (error) {
      console.error("Error sending request to Django API:", error);
      return "[Error] Failed to contact ChatGPT backend";
    }
  }

  // NEW: Piper TTS playback via backend /api/tts/
  async function speakWithPiper(text) {
    const cleaned = (text || "").trim();
    if (!cleaned) return;

    // Abort any previous in-flight TTS request
    try {
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
    } catch {}

    const controller = new AbortController();
    ttsAbortRef.current = controller;

    const res = await fetch(`${API_BASE}/tts/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cleaned }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`TTS failed (${res.status}): ${errText || "Unknown error"}`);
    }

    const blob = await res.blob();

    if (!audioRef.current) return;

    // Clean up any previous object URL
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
          playPromise.catch((e) => {
            cleanup(() => reject(e));
          });
        }
      } catch (e) {
        cleanup(() => reject(e));
      }
    });
  }

 async function fetchPiperBlob(text, signal, meta = {}) {
  const cleaned = (text || "").trim();
  if (!cleaned) return null;

  const id = meta.id ?? "?";
  const i = meta.i ?? "?";
  const t0 = performance.now();

  dbg(`🎛️ [TTS FETCH START] chunk=${id} sent=${i} chars=${cleaned.length}`);
  dbg(`🗣️ [SENTENCE TEXT] chunk=${id} sent=${i} ->`, cleaned);

  const res = await fetch(`${API_BASE}/tts/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: cleaned }),
    signal,
  });

  const t1 = performance.now();
  dbg(`📡 [TTS FETCH RESP ] chunk=${id} sent=${i} status=${res.status} (${Math.round(t1 - t0)}ms)`);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS failed (${res.status}): ${errText || "Unknown error"}`);
  }

  const blob = await res.blob();
  const t2 = performance.now();
  dbg(`📦 [TTS BLOB READY] chunk=${id} sent=${i} bytes=${blob.size} (${Math.round(t2 - t0)}ms total)`);

  return blob;
}


async function playBlob(blob, meta = {}) {
  if (!blob || !audioRef.current) return;

  const id = meta.id ?? "?";
  const i = meta.i ?? "?";

  if (audioObjectUrlRef.current) {
    URL.revokeObjectURL(audioObjectUrlRef.current);
    audioObjectUrlRef.current = null;
  }

  const url = URL.createObjectURL(blob);
  audioObjectUrlRef.current = url;

  await new Promise((resolve, reject) => {
    const audio = audioRef.current;
    const t0 = performance.now();

    const onEnded = () => {
      dbg(`✅ [PLAY ENDED] chunk=${id} sent=${i} played_ms=${Math.round(performance.now() - t0)}`);
      cleanup(resolve);
    };

    const onError = (e) => {
      dbg(`❌ [PLAY ERROR] chunk=${id} sent=${i}`, e);
      cleanup(() => reject(e));
    };

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

      dbg(`▶️ [PLAY START] chunk=${id} sent=${i} blob_bytes=${blob.size}`);

      const p = audio.play();
      if (p?.catch) p.catch((e) => cleanup(() => reject(e)));
    } catch (e) {
      cleanup(() => reject(e));
    }
  });
}



function stopAudioNow() {
  dbg("🛑 stopAudioNow(): aborting fetch + stopping audio");

  try {
    if (ttsAbortRef.current) ttsAbortRef.current.abort();
  } catch {}

  // Abort any pending prefetch controllers
  if (window._prefetchControllers) {
    window._prefetchControllers.forEach(c => {
      try { c.abort(); } catch {}
    });
    window._prefetchControllers = [];
  }

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

async function startReadingFromPosition(anchorSpan) {
  if (!anchorSpan) return;

  setIsReading(true);
  isReadingRef.current = true;
  setCurrentReadingPosition(anchorSpan);

  const initialChunk = await buildChunkFromAnchor(anchorSpan);
  if (!initialChunk) {
    setIsReading(false);
    isReadingRef.current = false;
    return;
  }

  currentChunkRef.current = initialChunk;
  nextChunkPromiseRef.current = null;

  startReadingLoop();
}

async function prefetchChunkAudios(chunkData, abortSignal) {
  const sentences = chunkData.cleanedSentences || [];
  if (!sentences.length) return [];

  const blobs = new Array(sentences.length);

  await Promise.allSettled(
    sentences.map(async (sentence, idx) => {
      try {
        blobs[idx] = await fetchPiperBlob(sentence, abortSignal, {
          id: chunkData.chunkId || "prefetch",
          i: idx,
          prefetch: true,
        });
      } catch (e) {
        console.error(`Prefetch failed for sentence ${idx}:`, e);
        blobs[idx] = null;
      }
    })
  );

  chunkData.audioBlobs = blobs;
  return blobs;
}

async function startReadingLoop() {
  while (isReadingRef.current && currentChunkRef.current) {
    const currentChunk = currentChunkRef.current;

    highlightSpan(currentChunk.startElement);

    // Start preparing the next chunk immediately while current chunk is playing
    if (!nextChunkPromiseRef.current) {
      nextChunkPromiseRef.current = buildAndPrefetchNextChunk(currentChunk);
    }

  let blobs = currentChunk.audioBlobs;

  // If blobs array does not exist yet, start/await generation
  if (!blobs) {
    blobs = currentChunk.audioPromise
      ? await currentChunk.audioPromise
      : await prefetchChunkAudios(currentChunk, currentChunk.abortController?.signal);
    currentChunk.audioBlobs = blobs;
  }

  // If blobs array exists but is not populated yet, wait for the promise
  else if (currentChunk.audioPromise) {
    blobs = await currentChunk.audioPromise;
    currentChunk.audioBlobs = blobs;
  }

    const groups = currentChunk.rawSentenceSpanGroups || [];
    const nSpeak = currentChunk.cleanedSentences?.length || 0;

    dbg(`\n===== START CHUNK ${currentChunk.chunkId} (${nSpeak} sentences) =====`);

    for (let i = 0; i < nSpeak; i++) {
      if (!isReadingRef.current) {
        dbg(`🛑 Stopped at sentence ${i} of chunk ${currentChunk.chunkId}`);
        break;
      }

      const spanGroup = groups[i] || [];
      spanGroup.forEach(el => highlightSpan(el));

      const sentenceBlob = currentChunk.audioBlobs?.[i];
      if (sentenceBlob) {
        await playBlob(sentenceBlob, { id: currentChunk.chunkId, i });
      } else {
        console.warn(`Missing blob for sentence ${i}, skipping`);
      }

      spanGroup.forEach(el => removeHighlight(el));
    }

    dbg(`===== END CHUNK ${currentChunk.chunkId} =====`);

    removeHighlight(currentChunk.startElement);

    const nextChunk = await nextChunkPromiseRef.current;
    nextChunkPromiseRef.current = null;
    currentChunkRef.current = nextChunk;
  }

  setIsReading(false);
  isReadingRef.current = false;

  if (window._prefetchControllers) {
    window._prefetchControllers.forEach(c => c.abort());
    window._prefetchControllers = [];
  }

  console.log("Reading finished");
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

  try {
    currentChunkRef.current?.abortController?.abort();
  } catch {}

  currentChunkRef.current = null;
  nextChunkPromiseRef.current = null;

  stopAudioNow();

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

        {isReading && (
          <span style={{ marginLeft: "10px", color: "#666" }}>
            Reading...
          </span>
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
