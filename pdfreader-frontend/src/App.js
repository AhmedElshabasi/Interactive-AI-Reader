import React from 'react';
import PdfViewer from './PdfViewer';
import './App.css';

function App() {
  return (
    <div className="App">
      <h1>I hope you see the vision (cause I still don't)</h1>
      {/* You can replace the URL below with any PDF file you want to display */}
      <PdfViewer
        fileUrl={
          process.env.REACT_APP_DEFAULT_PDF_URL ||

          "/Ammous,_Saifedean_The_Bitcoin_standard_the_decentralized_alternative.pdf"
        }
      />
    </div>
  );
}

export default App;
