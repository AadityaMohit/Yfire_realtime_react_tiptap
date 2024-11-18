import {
  getFirestore,
  onSnapshot,
  doc,
  setDoc,
  Bytes
} from "@firebase/firestore"
import { collection } from "firebase/firestore"
import * as Y from "yjs"
import { ObservableV2 } from "lib0/observable"
import * as awarenessProtocol from "y-protocols/awareness"
import { get as getLocal, set as setLocal, del as delLocal } from "idb-keyval"

import { deleteInstance, initiateInstance, refreshPeers } from "./utils"
import { WebRtc } from "./webrtc"
import { createGraph } from "./graph"

/**
 * FireProvider class that handles firestore data sync and awareness
 * based on webRTC.
 * @param firebaseApp Firestore instance
 * @param ydoc ydoc
 * @param path path to the firestore document (ex. collection/documentuid)
 * @param maxUpdatesThreshold maximum number of updates to wait for before sending updates to peers
 * @param maxWaitTime maximum miliseconds to wait before sending updates to peers
 * @param maxWaitFirestoreTime miliseconds to wait before syncing this client's update to firestore
 */
export class FireProvider extends ObservableV2 {
  timeOffset = 0 // offset to server time in mili seconds

  clients = []
  peersReceivers = new Set([])
  peersSenders = new Set([])

  peersRTC = {
    receivers: {},
    senders: {}
  }

  documentMapper = bytes => ({ content: 
    
    bytes })

  maxCacheUpdates = 20
  cacheUpdateCount = 0
  maxRTCWait = 100
  maxFirestoreWait = 3000

  firebaseDataLastUpdatedAt = new Date().getTime()

  instanceConnection = new ObservableV2()

  get clientTimeOffset() {
    return this.timeOffset
  }

  ready = false

  init = async () => {
    this.trackData()  
    try {
      const data = await initiateInstance(this.db, this.documentPath)
      this.instanceConnection.on("closed", this.trackConnections)
      this.uid = data.uid
      this.timeOffset = data.offset
      this.initiateHandler()
      window.addEventListener("beforeunload", this.destroy); // fixed

    } catch (error) {
      this.consoleHandler("Could not connect to a peer network.")
      this.kill(true) // destroy provider but keep the read-only stream alive
    }
  }

  syncLocal = async () => {
    try {
      const local = await getLocal(this.documentPath)
      if (local) Y.applyUpdate(this.doc, local, { key: "local-sync" })
    } catch (e) {
      this.consoleHandler("get local error", e)
    }
  }

  saveToLocal = async () => {
    try {
      const currentDoc = Y.encodeStateAsUpdate(this.doc)
      setLocal(this.documentPath, currentDoc)
    } catch (e) {
      this.consoleHandler("set local error", e)
    }
  }

  deleteLocal = async () => {
    try {
      delLocal(this.documentPath)
    } catch (e) {
      this.consoleHandler("del local error", e)
    }
  }

  initiateHandler = () => {
    this.consoleHandler("FireProvider initiated!")
    this.awareness.on("update", this.awarenessUpdateHandler)
    // We will track the mesh document on Firestore to
    // keep track of selected peers
    this.trackMesh()
    this.doc.on("update", this.updateHandler)
    this.syncLocal() // if there's any data in indexedDb, get and apply
  }

  trackData = () => {
    // Whenever there are changes to the firebase document
    // pull the changes and merge them to the current
    // yjs document
    if (this.unsubscribeData) this.unsubscribeData()
    this.unsubscribeData = onSnapshot(
      doc(this.db, this.documentPath),
      doc => {
        if (doc.exists()) {
          const data = doc.data()
          if (data && data.content) {
            this.firebaseDataLastUpdatedAt = new Date().getTime()
            const content = data.content.toUint8Array()
            const origin = "origin:firebase/update" // make sure this does not coincide with UID
            Y.applyUpdate(this.doc, content, origin)
          }
          if (!this.ready) {
            if (this.onReady) {
              this.onReady()
              this.ready = true
            }
          }
        }
      },
      error => {
        this.consoleHandler("Firestore sync error", error)
        if (error.code === "permission-denied") {
          if (this.onDeleted) this.onDeleted()
        }
      }
    )
  }

  trackMesh = () => {
    if (this.unsubscribeMesh) this.unsubscribeMesh()
    this.unsubscribeMesh = onSnapshot(
      collection(this.db, `${this.documentPath}/instances`),
      snapshot => {
        this.clients = []
        snapshot.forEach(doc => {
          this.clients.push(doc.id)
        })
        const mesh = createGraph(this.clients)

        // a -> b, c; a is the sender and b, c are receivers
        const receivers = mesh[this.uid] // this user's receivers
        const senders = Object.keys(mesh).filter(
          (v, i) => mesh[v] && mesh[v].length && mesh[v].includes(this.uid)
        ) // this user's senders

        this.peersReceivers = this.connectToPeers(
          receivers,
          this.peersReceivers,
          true
        )
        this.peersSenders = this.connectToPeers(
          senders,
          this.peersSenders,
          false
        )
      },
      error => {
        this.consoleHandler("Creating peer mesh error", error)
      }
    )
  }

  reconnect = () => {
    if (this.recreateTimeout) clearTimeout(this.recreateTimeout)
    this.recreateTimeout = setTimeout(async () => {
      this.consoleHandler("triggering reconnect", this.uid)
      this.destroy()
      this.init()
    }, 200)
  }

  trackConnections = async () => {
    const clients = this.clients.length
    let connected = 0
    Object.values(this.peersRTC.receivers).forEach(receiver => {
      if (receiver.connection !== "closed") connected++
    })
    Object.values(this.peersRTC.senders).forEach(sender => {
      if (sender.connection !== "closed") connected++
    })
    if (clients > 1 && connected <= 0) {
      // we have lost connection with all peers
      // trigger re-generation of the graph/mesh
      this.reconnect()
    }
  }

  connectToPeers = (newPeers, oldPeers, isCaller) => {
    if (!newPeers) return new Set([])
    // We must:
    // 1. remove obselete peers
    // 2. add new peers
    // 3. no change to same peers
    const getNewPeers = refreshPeers(newPeers, oldPeers)
    const peersType = isCaller ? "receivers" : "senders"
    if (!this.peersRTC[peersType]) this.peersRTC[peersType] = {}
    if (getNewPeers.obselete && getNewPeers.obselete.length) {
      // Old peers, remove them
      getNewPeers.obselete.forEach(async peerUid => {
        if (this.peersRTC[peersType][peerUid]) {
          await this.peersRTC[peersType][peerUid].destroy()
          delete this.peersRTC[peersType][peerUid]
        }
      })
    }
    if (getNewPeers.new && getNewPeers.new.length) {
      // New peers, initiate new connection to them
      getNewPeers.new.forEach(async peerUid => {
        if (this.peersRTC[peersType][peerUid]) {
          await this.peersRTC[peersType][peerUid].destroy()
          delete this.peersRTC[peersType][peerUid]
        }
        this.peersRTC[peersType][peerUid] = new WebRtc({
          firebaseApp: this.firebaseApp,
          ydoc: this.doc,
          awareness: this.awareness,
          instanceConnection: this.instanceConnection,
          documentPath: this.documentPath,
          uid: this.uid,
          peerUid,
          isCaller
        })
      })
    }
    return new Set(newPeers)
  }

  sendDataToPeers = ({ from, message, data }) => {
    if (this.peersRTC) {
      if (this.peersRTC.receivers) {
        Object.keys(this.peersRTC.receivers).forEach(receiver => {
          if (receiver !== from) {
            const rtc = this.peersRTC.receivers[receiver]
            rtc.sendData({ message, data })
          }
        })
      }
      if (this.peersRTC.senders) {
        Object.keys(this.peersRTC.senders).forEach(sender => {
          if (sender !== from) {
            const rtc = this.peersRTC.senders[sender]
            rtc.sendData({ message, data })
          }
        })
      }
    }
  }

  saveToFirestore = async () => {
    try {
      // current document to firestore
      const ref = doc(this.db, this.documentPath)
      await setDoc(
        ref,
        this.documentMapper(
          Bytes.fromUint8Array(Y.encodeStateAsUpdate(this.doc))
        ),
        { merge: true }
      )
      this.deleteLocal() // We have successfully saved to Firestore, empty indexedDb for now
    } catch (error) {
      this.consoleHandler("error saving to firestore", error)
    } finally {
      if (this.onSaving) this.onSaving(false)
    }
  }

  sendToFirestoreQueue = () => {
    // if cache settles down, save document to firebase
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout) // kill other save processes first
    if (this.onSaving) this.onSaving(true)
    this.firestoreTimeout = setTimeout(() => {
      if (
        new Date().getTime() - this.firebaseDataLastUpdatedAt >
        this.maxFirestoreWait
      ) {
        this.saveToFirestore()
      } else {
        // A peer recently saved to firebase, let's wait a bit
        this.sendToFirestoreQueue()
      }
    }, this.maxFirestoreWait)
  }

  sendCache = from => {
    this.sendDataToPeers({
      from,
      message: null,
      data: this.cache
    })
    this.cache = null
    this.cacheUpdateCount = 0
    this.sendToFirestoreQueue() // save to firestore
  }

  sendToQueue = ({ from, update }) => {
    if (from === this.uid) {
      // this update was from this user
      if (this.cacheTimeout) clearTimeout(this.cacheTimeout)

      this.cache = this.cache ? Y.mergeUpdates([this.cache, update]) : update
      this.cacheUpdateCount++

      if (this.cacheUpdateCount >= this.maxCacheUpdates) {
        // if the cache was already merged 20 times (this.maxCacheUpdates), send
        // the updates in cache to the peers
        this.sendCache(from)
      } else {
        // Wait to see if the user make other changes
        // if the user does not make changes for the next 500ms
        // send updates in cache to the peers
        this.cacheTimeout = setTimeout(() => {
          this.sendCache(from)
        }, this.maxRTCWait)
      }
    } else {
      // this update was from a peer, not this user
      this.sendDataToPeers({
        from,
        message: null,
        data: update
      })
    }
  }

  updateHandler = (update, origin) => {
    // Origin can be of the following types
    // 1. User typed something -> origin: object
    // 2. User loaded something from local store -> origin: object
    // 3. User received update from a peer -> origin: string = peer uid
    // 4. User received update from Firestore -> origin: string = 'origin:firebase/update'
    // 5. Update triggered because user applied updates from the above sources -> origin: string = uid

    if (origin !== this.uid) {
      // We will not allow no. 5. to propagate any further

      // Apply updates received from no. 1 to 4. -> triggers no. 5
      Y.applyUpdate(this.doc, update, this.uid) // the third parameter sets the transaction-origin

      // Convert no. 1 and 2 to uid, because we want these to eventually trigger 'save' to Firestore
      // sendToQueue method will either:
      // 1. save origin:uid to Firestore (and send to peers through WebRtc)
      // 2. send updates from other origins through WebRtc only
      this.sendToQueue({
        from: typeof origin === "string" ? origin : this.uid,
        update
      })

      this.saveToLocal() // save data to local indexedDb
    }
  }

  awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
    const changedClients = added.concat(updated).concat(removed)
    this.sendDataToPeers({
      from: origin !== "local" ? origin : this.uid,
      message: "awareness",
      data: awarenessProtocol.encodeAwarenessUpdate(
        this.awareness,
        changedClients
      )
    })
  }

  consoleHandler = (message, data = null) => {
    console.log(
      "Provider:",
      this.documentPath,
      `this client: ${this.uid}`,
      message,
      data
    )
  }

  // use destroy directly if you don't need arguements
  // otherwise use kill
  destroy = () => {
    // we have to create a separate function here
    // because beforeunload only takes this.destroy
    // and not this.destroy() or with this.destroy(args)
    this.kill()
  }

  kill = (keepReadOnly = false) => {
    this.instanceConnection.destroy()
    window.removeEventListener("beforeunload", this.destroy); // fixed
    if (this.recreateTimeout) clearTimeout(this.recreateTimeout)
    if (this.cacheTimeout) clearTimeout(this.cacheTimeout)
    if (this.firestoreTimeout) clearTimeout(this.firestoreTimeout)
    this.doc.off("update", this.updateHandler)
    this.awareness.off("update", this.awarenessUpdateHandler)
    deleteInstance(this.db, this.documentPath, this.uid)
    if (this.unsubscribeData && !keepReadOnly) {
      this.unsubscribeData()
      delete this.unsubscribeData
    }
    if (this.unsubscribeMesh) {
      this.unsubscribeMesh()
      delete this.unsubscribeMesh
    }
    if (this.peersRTC) {
      if (this.peersRTC.receivers) {
        Object.values(this.peersRTC.receivers).forEach(receiver =>
          receiver.destroy()
        )
      }
      if (this.peersRTC.senders) {
        Object.values(this.peersRTC.senders).forEach(sender => sender.destroy())
      }
    }
    this.ready = false
    super.destroy()
  }

  constructor({
    firebaseApp,
    ydoc,
    path,
    docMapper,
    maxUpdatesThreshold,
    maxWaitTime,
    maxWaitFirestoreTime
  }) {
    super()

    // Initializing values
    this.firebaseApp = firebaseApp
    this.db = getFirestore(this.firebaseApp)
    this.doc = ydoc
    this.documentPath = path
    if (docMapper) this.documentMapper = docMapper
    if (maxUpdatesThreshold) this.maxCacheUpdates = maxUpdatesThreshold
    if (maxWaitTime) this.maxRTCWait = maxWaitTime
    if (maxWaitFirestoreTime) this.maxFirestoreWait = maxWaitFirestoreTime
    this.awareness = new awarenessProtocol.Awareness(this.doc)

    // Initialize the provider
    const init = this.init()
  }
}
