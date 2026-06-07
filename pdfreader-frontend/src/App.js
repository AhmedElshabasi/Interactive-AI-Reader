import React from 'react';
import PdfViewer from './PdfViewer';
import SplashScreen from './SplashScreen';
import './App.css';

function App() {
  return (
    <SplashScreen>
      <div className="App">
        <PdfViewer
          fileUrl={
            process.env.REACT_APP_DEFAULT_PDF_URL ||
            "/Ammous,_Saifedean_The_Bitcoin_standard_the_decentralized_alternative.pdf"
          }
        />
      </div>
    </SplashScreen>
  );
}

export default App;
