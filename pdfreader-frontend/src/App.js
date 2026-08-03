import React, { useEffect, useRef, useState } from "react";
import PdfViewer from "./PdfViewer";
import SplashScreen from "./SplashScreen";
import {
  getLaunchBook,
  saveImportedBook,
  setActiveBookId,
  touchBookOpened,
} from "./libraryStore";
import "./App.css";

const DEFAULT_PDF_URL =
  process.env.REACT_APP_DEFAULT_PDF_URL ||
  "/Ammous,_Saifedean_The_Bitcoin_standard_the_decentralized_alternative.pdf";

function App() {
  const [libraryReady, setLibraryReady] = useState(false);
  const [activeBook, setActiveBook] = useState(null);
  const [importError, setImportError] = useState("");
  const objectUrlRef = useRef(null);

  function revokeObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  function openBookRecord(book) {
    revokeObjectUrl();
    const url = URL.createObjectURL(book.blob);
    objectUrlRef.current = url;
    setActiveBook({
      id: book.id,
      name: book.name,
      fileUrl: url,
      initialPage: Math.max(1, book.lastPage || 1),
    });
    setImportError("");
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const book = await getLaunchBook();
        if (cancelled) return;
        if (book) {
          openBookRecord(book);
          await touchBookOpened(book.id);
        } else {
          setActiveBook({
            id: null,
            name: "Default PDF",
            fileUrl: DEFAULT_PDF_URL,
            initialPage: Math.max(
              1,
              parseInt(localStorage.getItem(`pdf-last-page:${DEFAULT_PDF_URL}`) || "1", 10) || 1
            ),
          });
        }
      } catch (err) {
        console.error("Failed to restore library:", err);
        if (!cancelled) {
          setActiveBook({
            id: null,
            name: "Default PDF",
            fileUrl: DEFAULT_PDF_URL,
            initialPage: Math.max(
              1,
              parseInt(localStorage.getItem(`pdf-last-page:${DEFAULT_PDF_URL}`) || "1", 10) || 1
            ),
          });
        }
      } finally {
        if (!cancelled) setLibraryReady(true);
      }
    })();

    return () => {
      cancelled = true;
      revokeObjectUrl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launch restore once
  }, []);

  async function handleImportFile(file) {
    if (!file) return;
    try {
      setImportError("");
      const book = await saveImportedBook(file);
      openBookRecord(book);
    } catch (err) {
      console.error("Import failed:", err);
      setImportError(err.message || "Could not import that PDF");
    }
  }

  async function handleSelectBook(book) {
    if (!book?.id) return;
    await setActiveBookId(book.id);
    await touchBookOpened(book.id);
    openBookRecord(book);
  }

  if (!libraryReady || !activeBook) {
    return (
      <SplashScreen>
        <div className="App library-loading">Loading library…</div>
      </SplashScreen>
    );
  }

  return (
    <SplashScreen>
      <div className="App">
        {importError && <div className="library-error">{importError}</div>}
        <PdfViewer
          key={activeBook.id || activeBook.fileUrl}
          bookId={activeBook.id}
          bookName={activeBook.name}
          fileUrl={activeBook.fileUrl}
          initialPage={activeBook.initialPage}
          onImportFile={handleImportFile}
          onSelectBook={handleSelectBook}
        />
      </div>
    </SplashScreen>
  );
}

export default App;
