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

  // Collect text chunks (paragraphs) from a starting position
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
          text: text
        });
        
        // Check if this span ends a paragraph (ends with sentence ending)
        if (isEndOfParagraph(currentSpan)) {
          // Finalize current chunk
          if (currentChunk.length > 0) {
            chunks.push({
              spans: [...currentChunk],
              rawText: currentChunk.map(s => s.text).join(' '),
              paragraphNumber: paragraphCount + 1
            });
            currentChunk = [];
            paragraphCount++;
          }
        }
      }
      
      currentSpan = getNextSpanGlobal(currentSpan);
    }
    
    // Add any remaining text as the last chunk
    if (currentChunk.length > 0) {
      chunks.push({
        spans: currentChunk,
        rawText: currentChunk.map(s => s.text).join(' '),
        paragraphNumber: paragraphCount + 1
      });
    }
    
    return chunks;
  }

  // Check if a span ends a paragraph
  function isEndOfParagraph(spanElement) {
    if (!spanElement) return false;
    
    const text = spanElement.textContent.trim();
    const rect = spanElement.getBoundingClientRect();
    const nextSpan = getNextSpanGlobal(spanElement);
    
    if (!nextSpan) return false;
    
    const nextRect = nextSpan.getBoundingClientRect();
    const nextText = nextSpan.textContent.trim();
    
    // Method 1: Check for double line breaks or significant spacing
    const verticalGap = nextRect.top - rect.bottom;
    
    // If there's a significant vertical gap (> 1.5x line height), it's likely a new paragraph
    if (verticalGap > rect.height * 1.5) {
      return true;
    }
    
    // Method 2: Check for paragraph indentation (first line of paragraph)
    const currentPage = spanElement.closest('.react-pdf__Page');
    const pageRect = currentPage?.getBoundingClientRect();
    
    if (pageRect) {
      const currentLeftMargin = rect.left - pageRect.left;
      const nextLeftMargin = nextRect.left - pageRect.left;
      
      // If next span is significantly more indented, it's likely a new paragraph
      if (nextLeftMargin > currentLeftMargin + 20) {
        return true;
      }
    }
    
    // Method 3: Check for common paragraph break patterns
    const paragraphStarters = [
      /^[A-Z][a-z]+:/,  // "Chapter:", "Section:", etc.
      /^\d+\./,         // "1.", "2.", etc.
      /^[A-Z][A-Z\s]+$/, // ALL CAPS headers
      /^[A-Z][a-z]+\s+[A-Z][a-z]+:/, // "Chapter One:", etc.
    ];
    
    for (const pattern of paragraphStarters) {
      if (pattern.test(nextText)) {
        return true;
      }
    }
    
    return false;
  }

  // Process text chunks through ChatGPT for cleaning
  async function processTextChunks(chunks) {
    // Combine all chunks into one large text block
    const combinedText = chunks.map(chunk => chunk.rawText).join('\n\n');
    
    try {
      // Send the entire combined text to ChatGPT for cleaning
      const cleanedText = await sendToChatGPT(combinedText);
      
      console.log(`Processed ${chunks.length} paragraphs together:`, cleanedText);
      
      // Return all chunks with the same cleaned text
      return chunks.map(chunk => ({
        ...chunk,
        cleanedText: cleanedText,
        readyForTTS: true
      }));
      
    } catch (error) {
      console.error('Error processing chunks:', error);
      // Fallback to raw text if ChatGPT fails
      return chunks.map(chunk => ({
        ...chunk,
        cleanedText: chunk.rawText,
        readyForTTS: true
      }));
    }
  }

  // Send text to ChatGPT for cleaning (simulated for now)
  async function sendToChatGPT(text) {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // This is where you'd make the actual ChatGPT API call
    // For now, just return a cleaned version
    return `[Cleaned by ChatGPT] ${text}`;
    
    // Real implementation would be something like:
    /*
    const response = await fetch('/api/chatgpt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Clean and format this text for text-to-speech reading. Make it flow naturally and fix any formatting issues: ${text}`,
        max_tokens: 1000
      })
    });
    
    const data = await response.json();
    return data.choices[0].text.trim();
    */
  }

  // Process text spans for TTS (this is where you'd send to ChatGPT API)
  async function processTextForTTS(spans) {
    // Instead of processing individual spans, collect them into chunks
    const chunks = collectTextChunks(spans[0]?.element, 5); // 5 paragraphs
    const processedChunks = await processTextChunks(chunks);
    
    // Convert chunks back to span format for compatibility
    const processedSpans = [];
    
    for (const chunk of processedChunks) {
      // Add the cleaned text to the first span of each chunk
      if (chunk.spans.length > 0) {
        processedSpans.push({
          ...chunk.spans[0],
          processedText: chunk.cleanedText,
          readyForTTS: true,
          isChunkStart: true,
          chunkSize: chunk.spans.length,
          chunkIndex: 0
        });
        
        // Add remaining spans as continuation (no additional processing)
        for (let i = 1; i < chunk.spans.length; i++) {
          processedSpans.push({
            ...chunk.spans[i],
            processedText: '', // Empty for continuation spans
            readyForTTS: false, // Don't read these individually
            isChunkStart: false,
            chunkSize: chunk.spans.length,
            chunkIndex: i
          });
        }
      }
    }
    
    return processedSpans;
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
      
      // Skip spans that are not meant to be read individually
      if (!currentSpan.readyForTTS) {
        continue;
      }
      
      // Highlight current span being read
      console.log("highlighting span", currentSpan.element);
      highlightSpan(currentSpan.element);
      
      // If this is a chunk start, read the entire cleaned text
      if (currentSpan.isChunkStart) {
        await simulateTTSReading(currentSpan.processedText);
        
        // Skip the remaining spans in this chunk
        for (let i = 0; i < currentSpan.chunkSize - 1; i++) {
          if (readingQueue.current.length > 0) {
            const skipSpan = readingQueue.current.shift();
            // Still highlight them briefly for visual feedback
            highlightSpan(skipSpan.element);
            setTimeout(() => removeHighlight(skipSpan.element), 100);
          }
        }
      } else {
        // Regular span reading (fallback)
        await simulateTTSReading(currentSpan.text);
      }
      
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