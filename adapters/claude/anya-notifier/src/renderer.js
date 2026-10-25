(() => {
  const stage = document.getElementById("stage");
  const bubble = document.getElementById("bubble");
  const cliTag = document.getElementById("cliTag");
  const bubbleTitle = document.getElementById("bubbleTitle");
  const bubbleMsg = document.getElementById("bubbleMsg");
  const sourceSummary = document.getElementById("sourceSummary");
  const badge = document.getElementById("badge");
  const badgeCount = document.getElementById("badgeCount");
  const pet = document.getElementById("petContainer");
  const canvas = document.getElementById("pet");
  const video = document.getElementById("petVideo");
  const image = document.getElementById("petImage");
  const ctx = canvas.getContext("2d", { alpha: true });

  const media = {
    celebrate: { video: "../assets/animations/celebrate.webm", image: "../assets/animations/celebrate.png" },
    idle: { video: "../assets/animations/idle.webm", image: "../assets/animations/idle.png" },
  };
  const palette = {
    hair: "#ef9db3", hairLight: "#ffd2dc", hairShade: "#c86e88", ink: "#563b49",
    skin: "#ffe6d9", cheek: "#ef91a2", green: "#25805d", greenLight: "#8ce4b0",
    uniform: "#24232b", gold: "#e3bd63", collar: "#fffaf2", ribbon: "#c83c55",
  };

  let mode = "idle";
  let renderer = "canvas";
  let artworkDataUrl = "";
  let width = 300;
  let height = 210;
  let dpr = 1;
  let pointer = { x: 0, y: 0 };
  let particles = [];
  let raf = 0;
  let mediaGeneration = 0;
  let lastShowAt = 0;
  let drag = null;

  function showArtwork() {
    if (!artworkDataUrl) {
      renderer = "canvas";
      image.style.display = "none";
      canvas.style.display = "block";
      return;
    }
    image.src = artworkDataUrl;
    image.style.display = "block";
    canvas.style.display = "block";
    renderer = "artwork";
    sizeExternalMedia();
  }

  function applyArtwork(data = {}) {
    if (typeof data.dataUrl !== "string" || !data.dataUrl.startsWith("data:image/png;base64,") || data.dataUrl.length > 5600000) return;
    artworkDataUrl = data.dataUrl;
    if (renderer !== "video" && renderer !== "media-image") showArtwork();
  }

  function roundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function path(points, fill, stroke = palette.ink, lineWidth = 1.5) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  function ellipse(x, y, rx, ry, fill, stroke = null, lineWidth = 1) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  function drawOrnament(x, y, direction, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(direction);
    ctx.scale(scale, scale);
    ctx.shadowColor = "rgba(39, 25, 31, .2)";
    ctx.shadowBlur = 3;
    ctx.fillStyle = "#29262d";
    ctx.strokeStyle = "#bd9750";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.5, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = palette.gold;
    ctx.lineWidth = 1.2;
    for (const bandY of [-5, 0, 5]) {
      ctx.beginPath();
      ctx.ellipse(0, bandY, 7, 2.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ellipse(0, -8.2, 2.2, 1.3, "#f4d37e");
    ctx.restore();
  }

  function drawEye(x, y, t, blink, expression) {
    if (expression === "heh") {
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - 7, y + 1);
      ctx.quadraticCurveTo(x, y + 5, x + 7, y - 1);
      ctx.stroke();
      return;
    }
    if (blink) {
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - 8, y);
      ctx.quadraticCurveTo(x, y + 4, x + 8, y);
      ctx.stroke();
      return;
    }

    const eyeY = expression === "shock" ? y + 1 : y;
    const eyeH = expression === "shock" ? 9.5 : 10.5;
    ellipse(x, eyeY, 7.5, eyeH, "#fffdf8", palette.ink, 1.2);
    const lookX = Math.max(-2.4, Math.min(2.4, (pointer.x - 0.5) * 4));
    const lookY = Math.max(-1.5, Math.min(1.5, (pointer.y - 0.5) * 3));
    const irisX = x + lookX;
    const irisY = eyeY + 1.3 + lookY;
    const grad = ctx.createRadialGradient(irisX - 1, irisY - 2, 1, irisX, irisY, 6.5);
    grad.addColorStop(0, "#9aefba");
    grad.addColorStop(0.4, palette.greenLight);
    grad.addColorStop(1, palette.green);
    ellipse(irisX, irisY, 5.2, 7, grad);
    ellipse(irisX, irisY + 0.7, 2.1, 4.1, "#153e32");
    ellipse(irisX - 1.8, irisY - 2.4, 1.8, 2.2, "#fff");
    ellipse(irisX + 2, irisY + 2.4, 0.9, 1.1, "#e7fff1");
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 7, eyeY - eyeH + 1);
    ctx.quadraticCurveTo(x, eyeY - eyeH - 2, x + 7, eyeY - eyeH + 1);
    ctx.stroke();
    if (expression === "waku") {
      ctx.fillStyle = "#fff3a6";
      ctx.font = "bold 7px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("✦", x, eyeY + 2.4);
    }
  }

  function drawCharacter(t) {
    const compact = false;
    const expression = !compact && mode === "waku" && t - lastShowAt > 2600 && t - lastShowAt < 3550
      ? "heh"
      : mode;
    const scale = compact
      ? Math.min(0.62, Math.max(0.2, (width - 4) / 102), Math.max(0.2, (height - 6) / 112))
      : Math.min(1, width / 285, height / 210);
    const cx = width * 0.5;
    const bob = compact ? Math.sin(t / 600) * 1.2 : Math.sin(t / 430) * (mode === "waku" ? 2.3 : 1.1);
    const faceY = compact ? height * 0.55 : height * 0.57;
    const rx = 41;
    const ry = 39;

    ctx.save();
    ctx.translate(cx, faceY + bob);
    ctx.scale(scale, scale);

    // Uniform and sleeves sit behind the head.
    if (!compact) {
      const bodyY = 21;
      ctx.fillStyle = palette.uniform;
      ctx.strokeStyle = "#17161c";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-25, bodyY - 3);
      ctx.quadraticCurveTo(-35, bodyY + 12, -39, bodyY + 44);
      ctx.quadraticCurveTo(0, bodyY + 53, 39, bodyY + 44);
      ctx.quadraticCurveTo(35, bodyY + 12, 25, bodyY - 3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = palette.gold;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(-30, bodyY + 14); ctx.lineTo(-34, bodyY + 43);
      ctx.moveTo(30, bodyY + 14); ctx.lineTo(34, bodyY + 43);
      ctx.stroke();

      const armWave = mode === "waku" ? Math.sin(t / 125) * 0.08 : 0;
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(side * 28, bodyY + 3);
        ctx.rotate(side * (mode === "waku" ? -0.62 + armWave : 0.85));
        ctx.fillStyle = palette.uniform;
        roundedRect(-6, -25, 12, 31, 6);
        ctx.fill();
        ctx.strokeStyle = "#17161c";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ellipse(0, -27, 5.6, 5.6, palette.skin, palette.ink, 1.1);
        ctx.restore();
      }

      path([[-23, bodyY - 3], [-9, bodyY + 10], [0, bodyY + 4], [9, bodyY + 10], [23, bodyY - 3], [13, bodyY + 18], [0, bodyY + 11], [-13, bodyY + 18]], palette.collar, "#aaa0a0", 1.2);
      path([[0, bodyY + 8], [-8, bodyY + 15], [-3, bodyY + 19], [0, bodyY + 14], [3, bodyY + 19], [8, bodyY + 15]], palette.ribbon, "#8d263a", 1.2);
      ellipse(0, bodyY + 9, 3, 2.6, "#e15168", "#8d263a", 0.8);
    }

    const headBob = compact ? 0 : (mode === "waku" ? -Math.abs(Math.sin(t / 180)) * 3.4 : 0);
    ctx.save();
    ctx.translate(0, headBob);
    ctx.rotate(expression === "heh" ? 0.045 : Math.sin(t / 1100) * 0.012);

    // Back bob and side locks.
    const hair = ctx.createLinearGradient(0, -52, 0, 45);
    hair.addColorStop(0, palette.hairLight);
    hair.addColorStop(0.56, palette.hair);
    hair.addColorStop(1, palette.hairShade);
    ctx.fillStyle = hair;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-32, -20);
    ctx.bezierCurveTo(-51, -4, -49, 24, -40, 37);
    ctx.lineTo(-31, 31);
    ctx.quadraticCurveTo(-28, 43, -18, 34);
    ctx.lineTo(18, 34);
    ctx.quadraticCurveTo(28, 43, 31, 31);
    ctx.lineTo(40, 37);
    ctx.bezierCurveTo(49, 24, 51, -4, 32, -20);
    ctx.bezierCurveTo(18, -51, -18, -51, -32, -20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Face silhouette.
    ctx.fillStyle = palette.skin;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(-rx * 0.86, -ry * 0.38);
    ctx.bezierCurveTo(-rx * 1.02, ry * 0.3, -rx * 0.55, ry * 0.91, 0, ry * 0.94);
    ctx.bezierCurveTo(rx * 0.55, ry * 0.91, rx * 1.02, ry * 0.3, rx * 0.86, -ry * 0.38);
    ctx.bezierCurveTo(rx * 0.72, -ry * 1.02, -rx * 0.72, -ry * 1.02, -rx * 0.86, -ry * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Soft cheeks and tiny blush strokes.
    ellipse(-25, 11, 7, 4.2, "rgba(239,145,162,.38)");
    ellipse(25, 11, 7, 4.2, "rgba(239,145,162,.38)");
    ctx.strokeStyle = "rgba(213,105,128,.55)";
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(side * (22 + i * 3), 10);
        ctx.lineTo(side * (23 + i * 3), 13);
        ctx.stroke();
      }
    }

    const blink = (t % 4100) > 3970;
    drawEye(-15, 1, t, blink, expression);
    drawEye(15, 1, t, blink, expression);

    // Brows, nose and expression-specific mouth.
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (expression === "shock") {
      ctx.moveTo(-23, -12); ctx.lineTo(-9, -16);
      ctx.moveTo(9, -16); ctx.lineTo(23, -12);
    } else if (expression === "heh") {
      ctx.moveTo(-22, -12); ctx.quadraticCurveTo(-15, -15, -9, -11);
      ctx.moveTo(9, -12); ctx.quadraticCurveTo(16, -16, 23, -11);
    } else {
      ctx.moveTo(-22, -13); ctx.quadraticCurveTo(-15, -17, -9, -13);
      ctx.moveTo(9, -13); ctx.quadraticCurveTo(15, -17, 22, -13);
    }
    ctx.stroke();
    ellipse(0, 11, 1.1, 1, "#cf8d84");

    if (expression === "waku") {
      ctx.fillStyle = "#c94e69";
      ctx.strokeStyle = "#7e3046";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-7, 17); ctx.quadraticCurveTo(0, 14, 7, 17);
      ctx.quadraticCurveTo(7, 26, 0, 27);
      ctx.quadraticCurveTo(-7, 26, -7, 17);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ellipse(0, 23, 3.2, 1.6, "#f58ca0");
    } else if (expression === "shock") {
      ellipse(0, 20, 4.2, 5.2, "#a83d56", "#6c283a", 1.2);
    } else {
      ctx.beginPath();
      ctx.moveTo(-8, 19);
      ctx.quadraticCurveTo(0, expression === "heh" ? 25 : 24, 8, 18);
      ctx.stroke();
    }

    // Forelock and clean curved fringe.
    ctx.fillStyle = hair;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-37, -14);
    ctx.quadraticCurveTo(-33, -48, 0, -48);
    ctx.quadraticCurveTo(33, -48, 37, -14);
    ctx.lineTo(27, -7); ctx.lineTo(19, -18); ctx.lineTo(9, -5);
    ctx.lineTo(0, -16); ctx.lineTo(-9, -5); ctx.lineTo(-19, -18); ctx.lineTo(-27, -7);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // Hair gloss and signature ahoge.
    ctx.strokeStyle = "rgba(255,255,255,.63)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(-11, -28, 13, 3.5, 5.25); ctx.stroke();
    ctx.beginPath(); ctx.arc(13, -29, 9, 4.1, 5.5); ctx.stroke();
    ctx.save();
    ctx.translate(1, -47);
    ctx.rotate(Math.sin(t / 300) * 0.11);
    ctx.fillStyle = palette.hairLight;
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-3, 4); ctx.quadraticCurveTo(-9, -14, 5, -20);
    ctx.quadraticCurveTo(2, -7, 4, 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    drawOrnament(-31, -34, -0.35, 0.94);
    drawOrnament(31, -34, 0.35, 0.94);
    ctx.restore();

    if (mode === "shock" && !compact) {
      ctx.save();
      ctx.translate(38, 8);
      ctx.rotate(0.2);
      ctx.fillStyle = "#91d4f0";
      ctx.strokeStyle = "#4b91ae";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.bezierCurveTo(8, 0, 7, 7, 0, 8); ctx.bezierCurveTo(-7, 7, -8, 0, 0, -8); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawParticles(t) {
    particles = particles.filter((p) => t - p.start < p.life);
    for (const p of particles) {
      const age = Math.max(0, (t - p.start) / p.life);
      const y = p.y + age * p.rise;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = p.color;
      ctx.font = `bold ${p.size}px "Segoe UI Symbol", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(p.char, p.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (renderer === "canvas") {
      drawCharacter(t || 0);
    }
    if (renderer !== "video" && renderer !== "media-image") drawParticles(t || 0);
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = pet.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    width = rect.width;
    height = rect.height;
    dpr = Math.min(3, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (renderer !== "canvas") sizeExternalMedia();
  }

  function addParticles(kind, count) {
    const options = kind === "shock"
      ? [{ char: "💧", color: "#72c9e9" }, { char: "…", color: "#8894a7" }]
      : [{ char: "✦", color: "#f5c85d" }, { char: "♡", color: "#e9789a" }, { char: "✧", color: "#fff0a1" }];
    const now = performance.now();
    for (let i = 0; i < count; i++) {
      const item = options[Math.floor(Math.random() * options.length)];
      particles.push({
        char: item.char, color: item.color,
        x: width * (0.24 + Math.random() * 0.52),
        y: height * (0.42 + Math.random() * 0.24),
        rise: 24 + Math.random() * 35,
        size: 9 + Math.random() * 8,
        start: now + Math.random() * 120,
        life: 900 + Math.random() * 450,
      });
    }
  }

  function setSourceSummary(data) {
    const count = Number(data.count) || 0;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    sourceSummary.replaceChildren();
    sourceSummary.hidden = count <= 1;
    if (count <= 1) return;
    for (const source of sources) {
      const item = document.createElement("span");
      item.className = "source-item";
      item.textContent = source.label;
      if (source.count > 1) {
        const number = document.createElement("span");
        number.className = "source-count";
        number.textContent = String(source.count);
        item.appendChild(number);
      }
      sourceSummary.appendChild(item);
    }
  }

  function setBadge(count) {
    const n = Number(count) || 0;
    if (n > 1) {
      badgeCount.textContent = n > 9 ? "9+" : String(n);
      badge.classList.add("show");
    } else {
      badge.classList.remove("show");
    }
  }

  function stopMedia(invalidate = true) {
    if (invalidate) mediaGeneration++;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.style.display = "none";
    showArtwork();
  }

  function sizeExternalMedia() {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || width;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight || height;
    const available = Math.max(40, Math.min(viewportHeight - 104, viewportWidth - 24));
    video.style.height = `${available}px`;
    image.style.height = `${available}px`;
  }

  function loadPreferredMedia(aborted) {
    const generation = ++mediaGeneration;
    stopMedia(false);
    const state = aborted ? media.idle : media.celebrate;
    const candidateVideo = document.createElement("video");
    let settled = false;
    const fallbackToImage = () => {
      if (settled || generation !== mediaGeneration) return;
      settled = true;
      const candidate = new Image();
      const timer = setTimeout(() => fallbackToCanvas(), 700);
      candidate.onload = () => {
        if (generation !== mediaGeneration) return;
        clearTimeout(timer);
        image.src = state.image;
        image.style.display = "block";
        canvas.style.display = "none";
        renderer = "media-image";
        sizeExternalMedia();
      };
      candidate.onerror = () => {
        if (generation !== mediaGeneration) return;
        clearTimeout(timer);
        fallbackToCanvas();
      };
      candidate.src = state.image;
    };
    const fallbackToCanvas = () => {
      if (generation !== mediaGeneration) return;
      video.pause();
      video.style.display = "none";
      showArtwork();
    };
    candidateVideo.oncanplay = () => {
      if (settled || generation !== mediaGeneration) return;
      settled = true;
      video.src = state.video;
      video.style.display = "block";
      canvas.style.display = "none";
      renderer = "video";
      sizeExternalMedia();
      video.play().catch(() => fallbackToCanvas());
    };
    candidateVideo.onerror = fallbackToImage;
    candidateVideo.src = state.video;
    setTimeout(() => {
      if (candidateVideo.readyState < 2) fallbackToImage();
    }, 900);
  }

  function show(data = {}) {
    lastShowAt = performance.now();
    mode = data.aborted === true ? "shock" : "waku";
    pet.classList.toggle("celebrating", data.aborted !== true);
    pet.classList.toggle("aborted", data.aborted === true);
    stage.classList.add("expanded");
    bubble.classList.toggle("aborted", data.aborted === true);
    cliTag.textContent = data.source || "AI CLI";
    bubbleTitle.textContent = data.aborted === true ? "运行已中断" : "任务已完成";
    bubbleMsg.textContent = data.message || (data.aborted === true ? "本次运行已停止" : "任务已经完成，辛苦了");
    setSourceSummary(data);
    bubble.classList.add("show");
    setBadge(data.count);
    stage.classList.remove("pop");
    void stage.offsetWidth;
    stage.classList.add("pop");
    particles = [];
    addParticles(data.aborted === true ? "shock" : "happy", data.aborted === true ? 4 : 11);
    resize();
    loadPreferredMedia(data.aborted === true);
  }

  window.addEventListener("mousemove", (event) => {
    pointer.x = event.clientX / Math.max(1, window.innerWidth);
    pointer.y = event.clientY / Math.max(1, window.innerHeight);
  }, { passive: true });

  function beginDrag(event) {
    if (event.button !== 0 || drag) return;
    drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY };
    try { stage.setPointerCapture?.(event.pointerId); } catch {}
    window.anya.startDrag();
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    window.anya.moveDrag({ dx: event.screenX - drag.x, dy: event.screenY - drag.y });
    event.preventDefault();
  }

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    window.anya.endDrag();
    if (event) {
      try { stage.releasePointerCapture?.(event.pointerId); } catch {}
    }
    drag = null;
    event?.preventDefault();
  }

  stage.addEventListener("pointerdown", beginDrag, { passive: false });
  stage.addEventListener("pointermove", moveDrag, { passive: false });
  stage.addEventListener("pointerup", endDrag, { passive: false });
  stage.addEventListener("pointercancel", endDrag, { passive: false });
  window.addEventListener("blur", () => endDrag(), { passive: true });

  window.anya.onShow(show);
  window.anya.onArtwork(applyArtwork);
  window.addEventListener("resize", resize, { passive: true });
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(pet);
  resize();
  raf = requestAnimationFrame(frame);
  window.addEventListener("beforeunload", () => {
    if (raf) cancelAnimationFrame(raf);
  }, { once: true });
})();
