const STORAGE_KEY = "p2p-notes-sync-state";
const state = { noteText: "", tasks: [] };

let pc = null;
let dataChannel = null;
let syncTimer = null;

const notesEl = document.getElementById("notes");
const taskListEl = document.getElementById("taskList");
const addTaskBtn = document.getElementById("addTask");
const createOfferBtn = document.getElementById("createOffer");
const createAnswerBtn = document.getElementById("createAnswer");
const applySignalBtn = document.getElementById("applySignal");
const signalInputEl = document.getElementById("signalInput");
const syncStatusEl = document.getElementById("syncStatus");

function setStatus(message) {
  syncStatusEl.textContent = message;
}

function cloneState(inputState = state) {
  return {
    noteText: inputState.noteText || "",
    tasks: Array.isArray(inputState.tasks)
      ? inputState.tasks.map((task) => ({
          id: task.id || crypto.randomUUID(),
          text: typeof task.text === "string" ? task.text : "",
          done: Boolean(task.done)
        }))
      : []
  };
}

async function saveState() {
  const safeState = cloneState();
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: safeState });
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safeState));
}

async function loadState() {
  if (globalThis.chrome?.storage?.local) {
    const loaded = await chrome.storage.local.get(STORAGE_KEY);
    return cloneState(loaded[STORAGE_KEY]);
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return cloneState();
  }

  try {
    return cloneState(JSON.parse(raw));
  } catch {
    return cloneState();
  }
}

function broadcastState() {
  if (!dataChannel || dataChannel.readyState !== "open") {
    return;
  }

  dataChannel.send(
    JSON.stringify({
      type: "state",
      payload: cloneState()
    })
  );
}

function queueSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    saveState();
    broadcastState();
  }, 60);
}

function updateStateFromUi() {
  state.noteText = notesEl.value;
}

function renderTasks() {
  taskListEl.textContent = "";

  if (state.tasks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "text-xs text-slate-500";
    empty.textContent = "No tasks yet.";
    taskListEl.appendChild(empty);
    return;
  }

  state.tasks.forEach((task, index) => {
    const item = document.createElement("li");
    item.className = "flex items-center gap-2";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.done;
    checkbox.className = "h-4 w-4 rounded border-blue-300 text-emerald-600 focus:ring-emerald-300";
    checkbox.addEventListener("change", () => {
      state.tasks[index].done = checkbox.checked;
      queueSync();
    });

    const text = document.createElement("input");
    text.type = "text";
    text.value = task.text;
    text.placeholder = "Task details";
    text.className = "flex-1 rounded-md border border-blue-200 p-1.5 text-xs focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200";
    text.addEventListener("input", () => {
      state.tasks[index].text = text.value;
      queueSync();
    });

    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.className = "rounded-md bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-200";
    remove.addEventListener("click", () => {
      state.tasks.splice(index, 1);
      renderTasks();
      queueSync();
    });

    item.append(checkbox, text, remove);
    taskListEl.appendChild(item);
  });
}

function applyRemoteState(nextState) {
  const safe = cloneState(nextState);
  state.noteText = safe.noteText;
  state.tasks = safe.tasks;
  notesEl.value = state.noteText;
  renderTasks();
  saveState();
}

function attachDataChannel(channel) {
  dataChannel = channel;

  dataChannel.onopen = () => {
    setStatus("Connected - live sync active");
    broadcastState();
  };

  dataChannel.onclose = () => {
    setStatus("Disconnected");
  };

  dataChannel.onerror = () => {
    setStatus("Data channel error");
  };

  dataChannel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "state") {
        applyRemoteState(message.payload);
      }
    } catch {
      setStatus("Ignored invalid sync payload");
    }
  };
}

function setupPeerConnection() {
  if (pc) {
    return pc;
  }

  pc = new RTCPeerConnection({ iceServers: [] });

  pc.onconnectionstatechange = () => {
    setStatus(`WebRTC: ${pc.connectionState}`);
  };

  pc.ondatachannel = (event) => {
    attachDataChannel(event.channel);
  };

  return pc;
}

function waitForIceGatheringComplete(connection) {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onStateChange = () => {
      if (connection.iceGatheringState === "complete") {
        connection.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }
    };

    connection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

async function createOffer() {
  const connection = setupPeerConnection();

  if (!dataChannel) {
    attachDataChannel(connection.createDataChannel("notes-sync"));
  }

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGatheringComplete(connection);
  signalInputEl.value = JSON.stringify(connection.localDescription, null, 2);
  setStatus("Offer created. Share it with your peer.");
}

async function createAnswer() {
  const remote = parseSignal();
  if (!remote || remote.type !== "offer") {
    setStatus("Paste an offer to create an answer.");
    return;
  }

  const connection = setupPeerConnection();
  await connection.setRemoteDescription(remote);
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  await waitForIceGatheringComplete(connection);
  signalInputEl.value = JSON.stringify(connection.localDescription, null, 2);
  setStatus("Answer created. Share it back to the offer side.");
}

function parseSignal() {
  const raw = signalInputEl.value.trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    setStatus("Signal JSON is invalid.");
    return null;
  }
}

async function applySignal() {
  const remote = parseSignal();
  if (!remote) {
    return;
  }

  const connection = setupPeerConnection();

  if (remote.type === "offer") {
    await connection.setRemoteDescription(remote);
    setStatus("Offer applied. Click Create Answer.");
    return;
  }

  if (remote.type === "answer") {
    await connection.setRemoteDescription(remote);
    setStatus("Answer applied. Waiting for connection.");
    return;
  }

  setStatus("Unsupported signal type.");
}

function bindUi() {
  notesEl.addEventListener("input", () => {
    updateStateFromUi();
    queueSync();
  });

  addTaskBtn.addEventListener("click", () => {
    state.tasks.push({ id: crypto.randomUUID(), text: "", done: false });
    renderTasks();
    queueSync();
  });

  createOfferBtn.addEventListener("click", () => {
    createOffer().catch((error) => {
      console.error(error);
      setStatus("Failed to create offer.");
    });
  });

  createAnswerBtn.addEventListener("click", () => {
    createAnswer().catch((error) => {
      console.error(error);
      setStatus("Failed to create answer.");
    });
  });

  applySignalBtn.addEventListener("click", () => {
    applySignal().catch((error) => {
      console.error(error);
      setStatus("Failed to apply signal.");
    });
  });
}

async function init() {
  const loaded = await loadState();
  state.noteText = loaded.noteText;
  state.tasks = loaded.tasks;
  notesEl.value = state.noteText;
  renderTasks();
  bindUi();
}

init().catch(() => setStatus("Failed to initialize extension."));
