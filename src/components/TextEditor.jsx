import React, { useEffect, useRef, useState } from "react";
import { Editor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { yProvider } from "./yProvider";  

const TextEditor = ({ documentPath  }) => {
  const [editor, setEditor] = useState(null);
 
  useEffect(() => {
    const provider = yProvider(documentPath);

    provider.onReady = () => {
      console.log("Firebase sync is ready");
    };

    provider.onDeleted = () => {
      console.warn("The document has been deleted");
    };

    provider.onSaving = (status) => {
      console.log("Saving status:", status);
    };

    provider.init();

    const editorInstance = new Editor({
      extensions: [
        StarterKit.configure({ history: false }), 
        Collaboration.configure({
          document: provider.doc, 
        }),
        CollaborationCursor.configure({
          provider,
         
        }),
      ],
    });

    setEditor(editorInstance);

    return () => {
      editorInstance.destroy();
      provider.kill();
    };
  }, [documentPath ]);

 
  return (
    <div>
      {editor ? <EditorContent editor={editor} /> : <p>Loading editor...</p>}
    </div>
  );
};

export default TextEditor;
