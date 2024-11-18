import React from 'react';
import TextEditor from './components/TextEditor';

const App = () => {
  return (
    <div>
      <h1>Collaborative Notes</h1>
       <TextEditor documentPath="notes/doc1" />
    </div>
  );
};

export default App;
