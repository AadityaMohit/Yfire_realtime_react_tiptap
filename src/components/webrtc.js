import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"

import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  deleteDoc
} from "@firebase/firestore"
import { ObservableV2 } from "lib0/observable"
import SimplePeer from "simple-peer-light"
import {
  Uint8ArrayToBase64,
  base64ToUint8Array,
  decryptData,
  encryptData,
  generateKey,
  killZombie
} from "./utils"

export class WebRtc extends ObservableV2 {
  ice = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  }
  connection = "connecting"
  idleThreshold = 20000

  constructor({
    firebaseApp,
    ydoc,
    awareness,
    instanceConnection,
    documentPath,
    uid,
    peerUid,
    isCaller = false
  }) {
    super()
    this.doc = ydoc
    this.awareness = awareness
    this.instanceConnection = instanceConnection
    this.documentPath = documentPath
    this.uid = uid
    this.peerUid = peerUid
    this.db = getFirestore(firebaseApp)
    this.isCaller = isCaller
    /**
     * Let's initiate this peer. The peer
     * is NOT a caller unless specified
     */
    // this.consoleHandler("Peer initiated");
    this.initPeer()
  }

  initPeer = () => {
    this.createKey()
    if (this.isCaller) {
      this.callPeer()
    } else {
      this.replyPeer()
    }
    this.peer.on("data", this.handleReceivingData)
    this.handshake()
    this.peer.on("connect", this.handleOnConnected)
    this.peer.on("close", this.handleOnClose)

    this.startInitClock()
  }

  startInitClock = () => {
    /**
     * We will track how long it takes to connect to this peer
     * if it takes longer than idleThreshold, we assume that we are
     * connected to a zombie peer. Thus we will attempt to
     * kill the zombie instance
     */
    if (this.clock) clearTimeout(this.clock)
    this.clock = setTimeout(() => {
      if (this.connection !== "connected") {
        killZombie(this.db, this.documentPath, this.uid, this.peerUid)
        this.handleOnClose()
      }
    }, this.idleThreshold)
  }

  createKey = async () => {
    this.peerKey = await generateKey(
      this.isCaller ? this.uid : this.peerUid,
      this.isCaller ? this.peerUid : this.uid
    )
    // this.consoleHandler("key", this.peerKey);
    if (!this.peerKey) this.destroy()
  }

  createPeer = config => {
    this.peer = new SimplePeer(config)
  }

  callPeer = () => {
    this.createPeer({
      initiator: true,
      config: this.ice,
      trickle: false,
      channelName: `${this.documentPath}:${this.uid}_${this.peerUid}`
    })

    this.peer.on("signal", async signal => {
      /**
       * Write signal to ./instances/{peerUid}/calls/{uid}
       */
      // this.consoleHandler("Send call to peer");
      try {
        const callRef = doc(
          this.db,
          `${this.documentPath}/instances/${this.peerUid}/calls`,
          this.uid
        )
        await setDoc(callRef, { signal })

        setTimeout(() => {
          deleteDoc(callRef)
        }, this.idleThreshold) // delete call after defined miliseconds, if handshake hasn't deleted it yet
      } catch (error) {
        this.errorHandler(error)
      }
    })
  }

  replyPeer = () => {
    this.createPeer({
      initiator: false,
      config: this.ice,
      trickle: false
    })

    this.peer.on("signal", async signal => {
      /**
       * Write signal to ./instances/{peerUid}
       */
      // this.consoleHandler("Reply with answer");
      try {
        const answerRef = doc(
          this.db,
          `${this.documentPath}/instances/${this.peerUid}/answers`,
          this.uid
        )
        await setDoc(answerRef, { signal })

        setTimeout(() => {
          deleteDoc(answerRef)
        }, this.idleThreshold) // delete call after defined miliseconds, if handshake hasn't deleted it yet
      } catch (error) {
        this.errorHandler(error)
      }
    })
  }

  handshake = () => {
    this.unsubscribeHandshake = onSnapshot(
      // track own uid not peerUid
      doc(
        this.db,
        `${this.documentPath}/instances/${this.uid}/${
          this.isCaller ? "answers" : "calls"
        }/${this.peerUid}`
      ),
      doc => {
        const docData = doc.data()
        if (docData) {
          // this.consoleHandler("handshake");
          this.connect(docData.signal)
        }
      },
      error => {
        // this.consoleHandler("handshake error", error);
      }
    )
  }

  unsubHandshake = () => {
    if (this.unsubscribeHandshake) {
      this.unsubscribeHandshake()
      delete this.unsubscribeHandshake
    }
  }

  connect = signal => {
    try {
      this.unsubHandshake() // we already have a handshake, stop further handshakes
      if (this.peer) this.peer.signal(signal)
      this.deleteSignals() // Delete calls and answers docs because we already have a handshake
    } catch (error) {
      this.errorHandler(error)
    }
  }

  deleteSignals = () => {
    try {
      let ref
      if (this.isCaller) {
        ref = doc(
          this.db,
          `${this.documentPath}/instances/${this.peerUid}/calls`,
          this.uid
        )
      } else {
        ref = doc(
          this.db,
          `${this.documentPath}/instances/${this.peerUid}/answers`,
          this.uid
        )
      }
      deleteDoc(ref)
    } catch (error) {
      // this.consoleHandler("delete signals error", error);
    }
  }

  handleOnConnected = () => {
    // this.consoleHandler("Peer connected");
    this.connection = "connected"
    this.sendData({ message: "Hey!", data: null })
  }

  handleOnClose = () => {
    // this.consoleHandler("Peer disconnected");
    this.connection = "closed"
    this.instanceConnection.emit("closed", [true])
    this.destroy()
  }

  sendData = async ({ message, data }) => {
    const msg = {}
    msg.uid = this.uid
    if (message) msg.message = message
    if (data) {
      msg.data = await Uint8ArrayToBase64(data)
    }
    const encrypted = await encryptData(msg, this.peerKey)
    if (this.connection === "connected" && encrypted) this.peer.send(encrypted)
  }

  handleReceivingData = async data => {
    try {
      const decrypted = await decryptData(data, this.peerKey)
      if (decrypted) {
        if (decrypted.data) {
          decrypted.data = await base64ToUint8Array(decrypted.data)
        }
        if (decrypted.message === "awareness" && decrypted.data) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decrypted.data,
            decrypted.uid
          )
        } else if (!decrypted.message && decrypted.data) {
          // this.consoleHandler("decrypted data", decrypted);
          Y.applyUpdate(this.doc, decrypted.data, decrypted.uid)
        }
      }
    } catch (error) {
      this.errorHandler(error)
    }
  }

  consoleHandler = (message, data = null) => {
    console.log(
      "WebRTC",
      this.documentPath,
      `this client: ${this.uid}`,
      `peer client: ${this.peerUid}`,
      message,
      data
    )
  }

  errorHandler = error => {
    this.consoleHandler("Error", error)
  }

  async destroy() {
    // this.consoleHandler("destroyed");
    if (this.clock) clearTimeout(this.clock)
    if (this.peer) this.peer.destroy()
    this.unsubHandshake()
    this.deleteSignals() // Delete calls and answers
    super.destroy()
  }
}
