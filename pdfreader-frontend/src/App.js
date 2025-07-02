import React, { useEffect } from 'react';
import './App.css';

const pdfUrl = 'sample.pdf';
console.log(pdfUrl);
const viewerUrl = `http://localhost:55988/web/viewer.html?file=${encodeURIComponent(pdfUrl)}`;

function App() {
  useEffect(() => {
    function handleMessage(event) {
      console.log('Received postMessage event:', event); // Debugging message
      if (event.data?.type === 'pdf-text-selected') {
        const selectedText = event.data.text;
        console.log('Selected text from PDF.js:', selectedText);
        // Here you can abort TTS and start reading from selectedText
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div className="App">
      <h2>PDF.js Viewer</h2>
      <iframe
        title="PDF.js Viewer"
        src={viewerUrl}
        width="100%"
        height="900px"
        style={{ border: 'none' }}
        onLoad={() => console.log('PDF.js iframe loaded!')}
      />
    </div>
  );
}

export default App;
