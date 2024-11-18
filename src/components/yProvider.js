import * as Y from "yjs";
import { FireProvider } from "./FireProvider";
import { app } from "./firebase"; // Replace with the actual path to your Firebase client initialization

export const yProvider = (documentPath) => {
  const firebaseApp = app;  
  const ydoc = new Y.Doc();
  return new FireProvider({ firebaseApp, ydoc, path: documentPath });
};
