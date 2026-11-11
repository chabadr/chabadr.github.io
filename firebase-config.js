// Fill these in from: Firebase Console → Project settings → General →
// "Your apps" → Web app → SDK setup and configuration → Config.
// These values are safe to expose in client-side code; access is controlled
// by Firestore security rules, not by hiding this object.
export const firebaseConfig = {
  apiKey: "AIzaSyA7tRtwggT9wB6EfoerIEao5TbuU2Dxa3E",
  authDomain: "point-3a9cf.firebaseapp.com",
  projectId: "point-3a9cf",
  storageBucket: "point-3a9cf.firebasestorage.app",
  messagingSenderId: "953498896872",
  appId: "1:953498896872:web:c8c5f7ad27f38b927a3c5d",
};

export const isFirebaseConfigured = !firebaseConfig.apiKey.startsWith("PASTE_");
