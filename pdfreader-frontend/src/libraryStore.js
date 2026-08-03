const DB_NAME = "interactive-ai-reader";
const DB_VERSION = 1;
const BOOKS_STORE = "books";
const META_STORE = "meta";
const ACTIVE_BOOK_KEY = "activeBookId";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        const store = db.createObjectStore(BOOKS_STORE, { keyPath: "id" });
        store.createIndex("lastOpenedAt", "lastOpenedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open library DB"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function makeBookId() {
  return `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listBooks() {
  const db = await openDb();
  const tx = db.transaction(BOOKS_STORE, "readonly");
  const books = await requestToPromise(tx.objectStore(BOOKS_STORE).getAll());
  await txDone(tx);
  db.close();
  return (books || []).sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}

export async function getBook(id) {
  if (!id) return null;
  const db = await openDb();
  const tx = db.transaction(BOOKS_STORE, "readonly");
  const book = await requestToPromise(tx.objectStore(BOOKS_STORE).get(id));
  await txDone(tx);
  db.close();
  return book || null;
}

export async function getActiveBookId() {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readonly");
  const row = await requestToPromise(tx.objectStore(META_STORE).get(ACTIVE_BOOK_KEY));
  await txDone(tx);
  db.close();
  return row?.value || null;
}

export async function setActiveBookId(id) {
  const db = await openDb();
  const tx = db.transaction(META_STORE, "readwrite");
  tx.objectStore(META_STORE).put({ key: ACTIVE_BOOK_KEY, value: id });
  await txDone(tx);
  db.close();
}

export async function saveImportedBook(file) {
  if (!file) throw new Error("No file provided");
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) {
    throw new Error("Please choose a PDF file");
  }

  const id = makeBookId();
  const now = Date.now();
  const book = {
    id,
    name: file.name || "Untitled.pdf",
    size: file.size || 0,
    addedAt: now,
    lastOpenedAt: now,
    lastPage: 1,
    blob: file,
  };

  const db = await openDb();
  const tx = db.transaction([BOOKS_STORE, META_STORE], "readwrite");
  tx.objectStore(BOOKS_STORE).put(book);
  tx.objectStore(META_STORE).put({ key: ACTIVE_BOOK_KEY, value: id });
  await txDone(tx);
  db.close();
  return book;
}

export async function updateBookPage(id, page) {
  if (!id || !page || page < 1) return;
  const db = await openDb();
  const tx = db.transaction(BOOKS_STORE, "readwrite");
  const store = tx.objectStore(BOOKS_STORE);
  const book = await requestToPromise(store.get(id));
  if (book) {
    book.lastPage = page;
    book.lastOpenedAt = Date.now();
    store.put(book);
  }
  await txDone(tx);
  db.close();
}

export async function touchBookOpened(id) {
  if (!id) return;
  const db = await openDb();
  const tx = db.transaction(BOOKS_STORE, "readwrite");
  const store = tx.objectStore(BOOKS_STORE);
  const book = await requestToPromise(store.get(id));
  if (book) {
    book.lastOpenedAt = Date.now();
    store.put(book);
  }
  await txDone(tx);
  db.close();
}

export async function deleteBook(id) {
  if (!id) return;
  const db = await openDb();
  const tx = db.transaction([BOOKS_STORE, META_STORE], "readwrite");
  tx.objectStore(BOOKS_STORE).delete(id);
  const active = await requestToPromise(tx.objectStore(META_STORE).get(ACTIVE_BOOK_KEY));
  if (active?.value === id) {
    tx.objectStore(META_STORE).delete(ACTIVE_BOOK_KEY);
  }
  await txDone(tx);
  db.close();
}

/** Resolve the book that should open on launch (last active, else most recent). */
export async function getLaunchBook() {
  const activeId = await getActiveBookId();
  if (activeId) {
    const active = await getBook(activeId);
    if (active?.blob) return active;
  }
  const books = await listBooks();
  return books[0] || null;
}
