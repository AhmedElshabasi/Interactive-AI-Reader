import React, { useState, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

// Set workerSrc for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.mjs`;

export default function PdfViewer({ fileUrl }) {
  const [numPages, setNumPages] = useState(null);

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

      const nextSpan = getNextSpanGlobal(anchorNode);
      console.log("Next page's spans:", nextSpan);

    if (nextSpan) {
      const nextWord = nextSpan.textContent.trim().split(/\s+/)[0];
      
      console.log("Next word across pages:", nextWord);
    } else {
     
      console.log("No next span found (end of document?)");
    }
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div>
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