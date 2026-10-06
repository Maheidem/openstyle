const RELEASE_API =
  "https://api.github.com/repos/Maheidem/openstyle/releases/latest";
const FALLBACK_URL = "https://github.com/Maheidem/openstyle/releases/latest";

const PAIRS = [
  {
    raw: "um so I think we should uh ship the new version on friday and uh tell the team in the morning",
    clean:
      "I think we should ship the new version on Friday and tell the team in the morning.",
  },
  {
    raw: "so i need to email the client and uh attach the final invoice and ask for payment on the fifteenth",
    clean:
      "I need to email the client, attach the final invoice and ask for payment on the fifteenth.",
  },
  {
    raw: "send it to anna no wait to maria and let her know it is urgent",
    clean: "Send it to Maria and let her know it is urgent.",
  },
];

const WORD_INTERVAL_MS = 170;
const FADE_MS = 450;
const IDLE_HEIGHTS = [34, 58, 42, 72, 52, 84, 46, 66, 56, 78, 40, 60];

const reducedMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function loadRelease() {
  const downloads = document.querySelectorAll("[data-download]");
  const versionEl = document.querySelector("[data-version]");

  function fallback() {
    downloads.forEach((el) => {
      el.href = FALLBACK_URL;
    });
    if (versionEl) {
      versionEl.parentElement.hidden = true;
    }
  }

  fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
    .then((res) => {
      if (!res.ok) {
        throw new Error("release lookup failed");
      }
      return res.json();
    })
    .then((data) => {
      const dmg = (data.assets ?? []).find((asset) =>
        asset.name.endsWith(".dmg"),
      );
      if (!dmg?.browser_download_url) {
        throw new Error("no dmg asset");
      }
      downloads.forEach((el) => {
        el.href = dmg.browser_download_url;
      });
      if (versionEl && data.tag_name) {
        versionEl.textContent = `Version ${data.tag_name}`;
      }
    })
    .catch(fallback);
}

function initDemo() {
  const demo = document.querySelector("[data-demo]");
  const pill = document.querySelector("[data-pill]");
  const rawEl = document.querySelector("[data-raw]");
  const cleanEl = document.querySelector("[data-clean]");
  const placeholderEl = document.querySelector("[data-placeholder]");
  const body = document.querySelector(".window-body");
  const bars = Array.from(demo.querySelectorAll(".pill-bar"));

  if (!demo || !pill || !rawEl || !cleanEl || !placeholderEl || !body) {
    return;
  }

  let isHolding = false;
  let holdingSource = null;
  let nextPair = 0;
  let streamTimer = null;
  let waveTimer = null;
  let fadeTimer = null;
  let userStarted = false;

  bars.forEach((bar, i) => {
    bar.style.height = `${IDLE_HEIGHTS[i % IDLE_HEIGHTS.length]}%`;
  });

  function setHolding(on) {
    isHolding = on;
    demo.classList.toggle("is-holding", on);
  }

  function setWaveRandom() {
    bars.forEach((bar) => {
      bar.style.height = `${24 + Math.round(Math.random() * 68)}%`;
    });
  }

  function setWaveIdle() {
    bars.forEach((bar, i) => {
      bar.style.height = `${IDLE_HEIGHTS[i % IDLE_HEIGHTS.length]}%`;
    });
  }

  function clearTimers() {
    if (streamTimer) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
    if (waveTimer) {
      clearInterval(waveTimer);
      waveTimer = null;
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  function start(source) {
    if (isHolding) {
      return;
    }
    if (source !== "auto") {
      userStarted = true;
    }
    const pair = PAIRS[nextPair];
    nextPair = (nextPair + 1) % PAIRS.length;
    clearTimers();

    placeholderEl.hidden = true;
    cleanEl.hidden = true;
    rawEl.hidden = false;
    body.classList.remove("is-fading");
    rawEl.textContent = "";
    setHolding(true);
    holdingSource = source;

    if (reducedMotion) {
      rawEl.textContent = pair.raw;
      return;
    }

    const words = pair.raw.split(" ");
    let count = 0;
    rawEl.textContent = words[0];
    count = 1;
    streamTimer = setInterval(() => {
      count += 1;
      if (count < words.length) {
        rawEl.textContent = words.slice(0, count).join(" ");
      }
    }, WORD_INTERVAL_MS);
    waveTimer = setInterval(setWaveRandom, 120);
  }

  function stop() {
    if (!isHolding) {
      return;
    }
    const pair = PAIRS[(nextPair - 1 + PAIRS.length) % PAIRS.length];
    setHolding(false);
    holdingSource = null;
    clearTimers();
    setWaveIdle();

    if (reducedMotion) {
      rawEl.hidden = true;
      cleanEl.hidden = false;
      cleanEl.textContent = pair.clean;
      return;
    }

    body.classList.add("is-fading");
    fadeTimer = setTimeout(() => {
      rawEl.hidden = true;
      cleanEl.hidden = false;
      cleanEl.textContent = pair.clean;
    }, FADE_MS);
  }

  function isInteractive(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }
    if (el === pill) {
      return true;
    }
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      tag === "A" ||
      tag === "SUMMARY" ||
      el.isContentEditable
    );
  }

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) {
      return;
    }
    if (isInteractive(document.activeElement)) {
      return;
    }
    const demoHot =
      demo.matches(":hover") ||
      (document.activeElement && demo.contains(document.activeElement));
    if (demoHot) {
      e.preventDefault();
    }
    start("key");
  });

  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") {
      return;
    }
    if (isHolding && (holdingSource === "key" || holdingSource === "auto")) {
      stop();
    }
  });

  pill.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) {
      return;
    }
    e.preventDefault();
    start("key");
  });

  pill.addEventListener("keyup", (e) => {
    if (e.code !== "Space") {
      return;
    }
    e.preventDefault();
    if (isHolding && (holdingSource === "key" || holdingSource === "auto")) {
      stop();
    }
  });

  pill.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      pill.setPointerCapture(e.pointerId);
    } catch {
      // pointer capture is best effort
    }
    start("pointer");
  });

  function releasePointer() {
    if (isHolding && holdingSource === "pointer") {
      stop();
    }
  }

  pill.addEventListener("pointerup", releasePointer);
  pill.addEventListener("pointercancel", releasePointer);
  window.addEventListener("blur", stop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    }
  });

  if (reducedMotion) {
    placeholderEl.hidden = true;
    cleanEl.hidden = false;
    cleanEl.textContent = PAIRS[0].clean;
    return;
  }

  setTimeout(() => {
    if (userStarted || isHolding) {
      return;
    }
    start("auto");
    const played = PAIRS[(nextPair - 1 + PAIRS.length) % PAIRS.length];
    const words = played.raw.split(" ").length;
    setTimeout(
      () => {
        if (isHolding && holdingSource === "auto") {
          stop();
        }
      },
      words * WORD_INTERVAL_MS + 700,
    );
  }, 1500);
}

loadRelease();
initDemo();
