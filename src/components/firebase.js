import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
    apiKey: "AIzaSyAK3UIwUUwLLCGswz9lO90ICDviXmkOD2I",
    authDomain: "testextension-1e32b.firebaseapp.com",
    projectId: "testextension-1e32b",
    storageBucket: "testextension-1e32b.appspot.com",
    messagingSenderId: "736473904434",
    appId: "1:736473904434:web:77259b6327747127b9d32b",
    measurementId: "G-ZY1EZREYB3"
};

export const app = initializeApp(firebaseConfig);
export const firebaseApp = app;

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
