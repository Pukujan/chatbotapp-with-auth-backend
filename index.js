require("dotenv").config();
const express = require("express");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");
const cors = require("cors");
const authenticate = require("./middleware/auth"); // New auth middleware

// Initialize Firebase Admin SDK
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true
}));
app.use(express.json());

// Initialize OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Apply authentication middleware to all chat routes
app.use("/chat*", authenticate);

// Create a new chat
app.post("/chat", async (req, res) => {
  try {
    const { uid } = req.user; // From auth middleware
    const chatId = uuidv4();
    const chatData = {
      chatId,
      chatName: "New Chat",
      createdAt: admin.firestore.Timestamp.now(),
      userId: uid // Store user ID with chat
    };

    await db.collection("chats").doc(chatId).set(chatData);
    res.status(201).json(chatData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message and get AI response
app.post("/chat/:chatId/message", async (req, res) => {
  try {
    console.log("post chat");
    const { chatId } = req.params;
    const { uid } = req.user;
    const { sender, message } = req.body;
    const timestamp = admin.firestore.Timestamp.now();

    // Verify user owns the chat
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data().userId !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Store user message
    await db.collection("chats").doc(chatId).collection("messages").add({
      sender,
      message,
      timestamp,
      userId: uid // Track which user sent the message
    });

    // Get AI response
    const aiResponse = await openai.chat.completions.create({
      model: "rekaai/reka-flash-3:free",
      messages: [{ role: "user", content: message }],
    });

    if (!aiResponse.choices || aiResponse.choices.length === 0) {
      throw new Error("Invalid response from OpenRouter API");
    }

    const botReply = aiResponse.choices[0].message.content;

    // Store AI response
    await db.collection("chats").doc(chatId).collection("messages").add({
      sender: "AI",
      message: botReply,
      timestamp: admin.firestore.Timestamp.now(),
      userId: uid
    });

    res.status(201).json({ message: botReply });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Retrieve chat messages
app.get("/chat/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { uid } = req.user;

    // Verify user owns the chat
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data().userId !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const messagesSnapshot = await db.collection("chats")
      .doc(chatId)
      .collection("messages")
      .orderBy("timestamp")
      .get();

    const messages = messagesSnapshot.docs.map(doc => doc.data());
    res.status(200).json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all chats for current user
app.get("/chats", async (req, res) => {
  try {
    const { uid } = req.user;

    const chatsSnapshot = await db.collection("chats")
      .where("userId", "==", uid)
      .get();

    const chats = chatsSnapshot.docs.map(doc => ({
      chatId: doc.id,
      chatName: doc.data().chatName || "New Chat"
    }));

    res.status(200).json({ chats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update chat name
app.put("/chat/:chatId/name", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { uid } = req.user;
    const { chatName } = req.body;

    if (!chatName || typeof chatName !== 'string') {
      return res.status(400).json({ error: "Invalid chat name" });
    }

    // Verify user owns the chat
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data().userId !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await db.collection("chats").doc(chatId).update({ chatName });
    res.status(200).json({ message: "Chat name updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a chat
app.delete("/chat/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const { uid } = req.user;

    // Verify user owns the chat
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists || chatDoc.data().userId !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Delete all messages
    const messagesRef = db.collection("chats").doc(chatId).collection("messages");
    const messagesSnapshot = await messagesRef.get();
    const batch = db.batch();
    messagesSnapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Delete chat document
    await db.collection("chats").doc(chatId).delete();
    res.status(200).json({ message: "Chat deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});