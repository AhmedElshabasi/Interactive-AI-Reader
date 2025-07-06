import React, { useState, useEffect, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

// Set workerSrc for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.mjs`;

export default function PdfViewer({ fileUrl }) {
  const [numPages, setNumPages] = useState(null);
  const [isReading, setIsReading] = useState(false);
  const [currentReadingPosition, setCurrentReadingPosition] = useState(null);
  
  // Buffer management for continuous reading
  const textBuffer = useRef([]);
  const bufferSize = 10; // Number of spans to keep in buffer
  const isLoadingMore = useRef(false);
  const readingQueue = useRef([]);
  const currentSpanIndex = useRef(0);
  const isReadingRef = useRef(isReading);

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  function getNextSpanGlobal(anchorSpan) {
    if (!anchorSpan) return null;
  
    // Step 1: Get the parent page container
    const currentPage = anchorSpan.closest('.react-pdf__Page');
    if (!currentPage) return null;
  
    // Step 2: Get current text layer and all spans
    const currentTextLayer = currentPage.querySelector('.react-pdf__Page__textContent');
    const currentSpans = Array.from(currentTextLayer?.querySelectorAll('span') || []);
    const currentIndex = currentSpans.indexOf(anchorSpan);
  
    // Step 3: Try to get next span on the same page
    if (currentIndex >= 0 && currentIndex + 1 < currentSpans.length) {
      return currentSpans[currentIndex + 1];
    }
  
    // Step 4: Try to get the next page
    let nextPage = currentPage.nextElementSibling;
  
    while (nextPage) {
      const nextTextLayer = nextPage.querySelector('.react-pdf__Page__textContent');
      if (nextTextLayer) {
        const nextSpans = Array.from(nextTextLayer.querySelectorAll('span'));
        const firstMeaningfulSpan = nextSpans.find(span => span.textContent.trim().length > 0);
        if (firstMeaningfulSpan) {
          return firstMeaningfulSpan;
        }
      }
      nextPage = nextPage.nextElementSibling; // move to next page if needed
    }
  
    // If nothing found
    return null;
  }

  // Get all meaningful spans starting from a given span
  function getSpansFromPosition(startSpan, count = bufferSize) {
    const spans = [];
    let currentSpan = startSpan;
    
    for (let i = 0; i < count && currentSpan; i++) {
      const text = currentSpan.textContent.trim();
      if (text.length > 0) {
        spans.push({
          element: currentSpan,
          text: text,
          index: i
        });
      }
      currentSpan = getNextSpanGlobal(currentSpan);
    }
    
    return spans;
  }

  // Process text spans for TTS (this is where you'd send to ChatGPT API)
  async function processTextForTTS(spans) {
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return spans.map(span => ({
      ...span,
      processedText: `Processed: ${span.text}`, // This would be ChatGPT's response
      readyForTTS: true
    }));
  }

  // Load more text into buffer when needed
  async function loadMoreTextIntoBuffer() {
    if (isLoadingMore.current) return;
    
    isLoadingMore.current = true;
    
    try {
      // Get the last span in our buffer to continue from
      const lastSpan = textBuffer.current[textBuffer.current.length - 1]?.element;
      if (!lastSpan) return;
      
      // Get next span to start loading from
      const nextSpan = getNextSpanGlobal(lastSpan);
      if (!nextSpan) return;
      
      // Get new spans
      const newSpans = getSpansFromPosition(nextSpan, bufferSize);
      if (newSpans.length === 0) return;
      
      // Process them (send to ChatGPT API)
      const processedSpans = await processTextForTTS(newSpans);
      
      // Add to buffer
      textBuffer.current.push(...processedSpans);
      
      // Keep buffer size manageable
      if (textBuffer.current.length > bufferSize * 2) {
        textBuffer.current = textBuffer.current.slice(-bufferSize);
      }
      
      console.log(`Loaded ${newSpans.length} more spans into buffer. Buffer size: ${textBuffer.current.length}`);
      
    } catch (error) {
      console.error('Error loading more text:', error);
    } finally {
      isLoadingMore.current = false;
    }
  }

  // Start reading from a selected position
  async function startReadingFromPosition(anchorSpan) {
    if (!anchorSpan) return;
    
    setIsReading(true);
    setCurrentReadingPosition(anchorSpan);
    currentSpanIndex.current = 0;
    
    // Initialize buffer with spans from the selected position
    const initialSpans = getSpansFromPosition(anchorSpan, bufferSize);
    const processedSpans = await processTextForTTS(initialSpans);
    
    textBuffer.current = processedSpans;
    readingQueue.current = [...processedSpans];
    
    console.log(`Started reading with ${initialSpans.length} spans in buffer`);
    
    // Start the reading loop
    startReadingLoop();
  }

  // Main reading loop that handles both reading and loading
  async function startReadingLoop() {

    console.log("reading queue", readingQueue.current.length);
    console.log("isReading", isReadingRef.current);
    while (isReadingRef.current && readingQueue.current.length > 0) {
      console.log("reading queue", readingQueue.current);
      // Check if we need to load more text
      if (readingQueue.current.length < bufferSize / 2 && !isLoadingMore.current) {
        // Load more text in the background
        loadMoreTextIntoBuffer().then(() => {
          // Add newly loaded spans to reading queue
          const newSpans = textBuffer.current.slice(-bufferSize / 2);
          readingQueue.current.push(...newSpans);
        });
      }
      
      // Get next span to read
      const currentSpan = readingQueue.current.shift();
      if (!currentSpan) break;
      
      // Highlight current span being read
      console.log("highlighting span", currentSpan.element);
      highlightSpan(currentSpan.element);
      
      // Simulate TTS reading (replace with actual TTS)
      await simulateTTSReading(currentSpan.text);
      
      // Remove highlight
      removeHighlight(currentSpan.element);
      
      currentSpanIndex.current++;
    }
    
    setIsReading(false);
    console.log('Reading finished');
  }

  // Simulate TTS reading (replace with actual TTS implementation)
  async function simulateTTSReading(text) {
    console.log(`Reading: ${text}`);
    // This is where you'd integrate with actual TTS
    // For now, just wait a bit to simulate reading time
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Highlight the span being read
  function highlightSpan(spanElement) {
    if (spanElement) {
      spanElement.style.backgroundColor = 'yellow';
      spanElement.style.color = 'black';
    }
  }

  // Remove highlight from span
  function removeHighlight(spanElement) {
    if (spanElement) {
      spanElement.style.backgroundColor = '';
      spanElement.style.color = '';
    }
  }

  // Stop reading
  function stopReading() {
    setIsReading(false);
    readingQueue.current = [];
    // Remove any highlights
    document.querySelectorAll('.react-pdf__Page__textContent span').forEach(span => {
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

      // If user clicks on a span, start reading from there
      if (anchorNode && anchorNode.tagName === 'SPAN' && !isReading) {
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

  return (
    <div>
      <div style={{ marginBottom: '10px' }}>
        <button 
          onClick={stopReading} 
          disabled={!isReading}
          style={{ 
            padding: '8px 16px', 
            backgroundColor: isReading ? '#ff4444' : '#ccc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: isReading ? 'pointer' : 'not-allowed'
          }}
        >
          {isReading ? 'Stop Reading' : 'Not Reading'}
        </button>
        {isReading && (
          <span style={{ marginLeft: '10px', color: '#666' }}>
            Reading... Buffer: {textBuffer.current.length} spans
          </span>
        )}
      </div>
      
      <Document file={fileUrl} onLoadSuccess={onDocumentLoadSuccess}>
        {Array.from(new Array(numPages), (el, index) => (
          <Page
            key={`page_${index + 1}`}
            pageNumber={index + 1}
            renderAnnotationLayer={false}
          />
        ))}
      </Document>
    </div>
  );
} 