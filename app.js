// =====================================================
//  Álbum de pareja
//  - Con la nube configurada (config.js): todo se comparte entre los dos.
//  - Sin configurar: modo de prueba, se guarda solo en este aparato.
// =====================================================
const CFG = typeof CONFIG_NUBE !== "undefined" ? CONFIG_NUBE : {};
const NUBE = !!(CFG.url && CFG.clave && window.supabase && !/PEGA-AQUI/.test(CFG.url + CFG.clave));
const MAX_MB = CFG.maxMB || 50;
const BUCKET = "album";
const MIME = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

const $ = id => document.getElementById(id);
const uuid = () => crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
const extDe = (nombre, defecto) => ((nombre.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)) || defecto;

// ---------- Reducir fotos antes de subirlas (más rápido y ocupa menos) ----------
async function procesarImagen(archivo) {
  try {
    if (/gif|svg/.test(archivo.type)) throw 0;
    const url = URL.createObjectURL(archivo);
    const img = new Image(); img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    const ancho = img.naturalWidth, alto = img.naturalHeight;
    const reducir = (max, calidad) => new Promise((ok, fallo) => {
      const e = Math.min(1, max / Math.max(ancho, alto));
      const c = document.createElement("canvas");
      c.width = Math.round(ancho * e); c.height = Math.round(alto * e);
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => (b ? ok(b) : fallo()), "image/jpeg", calidad);
    });
    const mini = await reducir(480, .75);
    const grande = Math.max(ancho, alto) > 2400;
    const full = grande ? await reducir(2400, .88) : archivo;
    return { full, mini, ext: grande ? "jpg" : null };
  } catch (e) {
    return { full: archivo, mini: null, ext: null };
  }
}

// =====================================================
//  ALMACÉN LOCAL (modo de prueba): IndexedDB en este aparato
// =====================================================
function abrirDB() {
  return new Promise((ok, fallo) => {
    const req = indexedDB.open("mi-album", 2);
    req.onupgradeneeded = () => {
      ["fotos", "cartas"].forEach(n => {
        if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath: "id" });
      });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fallo(req.error);
  });
}
async function dbHacer(tienda, modo, fn) {
  const db = await abrirDB();
  return new Promise((ok, fallo) => {
    const tx = db.transaction(tienda, modo);
    const res = fn(tx.objectStore(tienda));
    tx.oncomplete = () => { db.close(); ok(res && res.result); };
    tx.onerror = tx.onabort = () => { db.close(); fallo(tx.error); };
  });
}
const dbTodas   = t => dbHacer(t, "readonly", s => s.getAll());
const dbGuardar = (t, o) => dbHacer(t, "readwrite", s => s.put(o));
const dbBorrar  = (t, id) => dbHacer(t, "readwrite", s => s.delete(id));
const datosFoto = f => ({ id: f.id, blob: f.blob, nombre: f.nombre, fav: f.fav, fecha: f.fecha });

const local = {
  async haySesion() { try { return sessionStorage.getItem("album-ok") === "1"; } catch (e) { return false; } },
  async entrar(pin) {
    if (pin !== String(CFG.claveLocal || "143143")) throw { status: 400 };
    try { sessionStorage.setItem("album-ok", "1"); } catch (e) {}
  },
  async salir() { try { sessionStorage.removeItem("album-ok"); } catch (e) {} },

  async listarFotos() {
    return (await dbTodas("fotos")).sort((a, b) => b.fecha - a.fecha).map(f => ({
      ...f, tipo: f.blob.type.startsWith("video/") ? "video" : "imagen",
      url: URL.createObjectURL(f.blob), mini: null
    }));
  },
  async subirFoto(a) {
    const f = { id: uuid(), nombre: a.name, fav: false, fecha: Date.now(), blob: a,
                tipo: a.type.startsWith("video/") ? "video" : "imagen" };
    await dbGuardar("fotos", datosFoto(f));
    f.url = URL.createObjectURL(a); f.mini = null;
    return f;
  },
  async guardarFav(f) { await dbGuardar("fotos", datosFoto(f)); },
  async borrarFoto(f) { URL.revokeObjectURL(f.url); await dbBorrar("fotos", f.id); },

  async listarCartas() { return (await dbTodas("cartas")).sort((a, b) => b.fecha - a.fecha); },
  async crearCarta(c, archivo) {
    const n = { ...c, id: uuid(), fecha: Date.now() };
    if (archivo) n.archivo = archivo;
    await dbGuardar("cartas", n);
    return n;
  },
  async actualizarCarta(c) { await dbGuardar("cartas", c); },
  async borrarCarta(c) { await dbBorrar("cartas", c.id); },
  async archivoCarta(c) { return c.archivo; }
};

// =====================================================
//  ALMACÉN EN LA NUBE (Supabase): compartido entre los dos
// =====================================================
let sb = null;
const cacheUrls = new Map();

async function firmar(rutas) {
  const ahora = Date.now();
  const faltan = [...new Set(rutas)].filter(r => r && !((cacheUrls.get(r) || {}).exp > ahora + 600000));
  if (!faltan.length) return;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(faltan, 43200);
  if (error) throw error;
  data.forEach(d => { if (d.signedUrl) cacheUrls.set(d.path, { url: d.signedUrl, exp: ahora + 43200000 }); });
}
const urlDe = r => (r && cacheUrls.get(r) ? cacheUrls.get(r).url : null);
async function subirObjeto(ruta, blob) {
  const { error } = await sb.storage.from(BUCKET).upload(ruta, blob, { contentType: blob.type || undefined, upsert: false });
  if (error) throw error;
}
const filaAFoto = r => ({
  id: r.id, nombre: r.nombre, fav: r.fav, fecha: +new Date(r.fecha), tipo: r.tipo,
  ruta: r.ruta, rutaMini: r.mini, url: urlDe(r.ruta), mini: urlDe(r.mini)
});
const filaACarta = r => ({
  id: r.id, titulo: r.titulo, texto: r.texto || "", fecha: +new Date(r.fecha),
  editada: r.editada ? +new Date(r.editada) : null, ext: r.ext, nombreArchivo: r.nombre_archivo, ruta: r.ruta
});

const nube = {
  async haySesion() { const { data } = await sb.auth.getSession(); return !!data.session; },
  async entrar(pin) {
    const { error } = await sb.auth.signInWithPassword({ email: CFG.correo, password: pin });
    if (error) throw error;
  },
  async salir() { await sb.auth.signOut(); },

  async listarFotos() {
    const { data, error } = await sb.from("fotos").select("*").order("fecha", { ascending: false });
    if (error) throw error;
    await firmar(data.flatMap(r => [r.ruta, r.mini]));
    return data.map(filaAFoto);
  },
  async subirFoto(archivo) {
    const esVideo = archivo.type.startsWith("video/");
    const id = uuid();
    let full = archivo, mini = null, ext = extDe(archivo.name, esVideo ? "mp4" : "jpg");
    if (!esVideo) {
      const r = await procesarImagen(archivo);
      full = r.full; mini = r.mini; if (r.ext) ext = r.ext;
    }
    if (full.size > MAX_MB * 1048576) throw { limite: true };
    const ruta = `fotos/${id}.${ext}`, rutaMini = mini ? `miniaturas/${id}.jpg` : null;
    await subirObjeto(ruta, full);
    try {
      if (mini) await subirObjeto(rutaMini, mini);
      const { data, error } = await sb.from("fotos")
        .insert({ id, nombre: archivo.name, ruta, mini: rutaMini, tipo: esVideo ? "video" : "imagen" })
        .select().single();
      if (error) throw error;
      await firmar([ruta, rutaMini]);
      return filaAFoto(data);
    } catch (e) {
      await sb.storage.from(BUCKET).remove([ruta, rutaMini].filter(Boolean));
      throw e;
    }
  },
  async guardarFav(f) {
    const { error } = await sb.from("fotos").update({ fav: f.fav }).eq("id", f.id);
    if (error) throw error;
  },
  async borrarFoto(f) {
    const { error } = await sb.from("fotos").delete().eq("id", f.id);
    if (error) throw error;
    await sb.storage.from(BUCKET).remove([f.ruta, f.rutaMini].filter(Boolean));
  },

  async listarCartas() {
    const { data, error } = await sb.from("cartas").select("*").order("fecha", { ascending: false });
    if (error) throw error;
    return data.map(filaACarta);
  },
  async crearCarta(c, archivo) {
    const id = uuid();
    let ruta = null;
    if (archivo) {
      if (archivo.size > MAX_MB * 1048576) throw { limite: true };
      ruta = `cartas/${id}.${c.ext}`;
      await subirObjeto(ruta, archivo);
    }
    const { data, error } = await sb.from("cartas")
      .insert({ id, titulo: c.titulo, texto: c.texto, ruta, nombre_archivo: c.nombreArchivo || null, ext: c.ext || null })
      .select().single();
    if (error) { if (ruta) await sb.storage.from(BUCKET).remove([ruta]); throw error; }
    return filaACarta(data);
  },
  async actualizarCarta(c) {
    const { error } = await sb.from("cartas")
      .update({ titulo: c.titulo, texto: c.texto, editada: new Date(c.editada || Date.now()).toISOString() })
      .eq("id", c.id);
    if (error) throw error;
  },
  async borrarCarta(c) {
    const { error } = await sb.from("cartas").delete().eq("id", c.id);
    if (error) throw error;
    if (c.ruta) await sb.storage.from(BUCKET).remove([c.ruta]);
  },
  async archivoCarta(c) {
    const { data, error } = await sb.storage.from(BUCKET).download(c.ruta);
    if (error) throw error;
    return new Blob([data], { type: MIME[c.ext] || data.type });
  }
};

if (NUBE) {
  sb = supabase.createClient(CFG.url, CFG.clave, {
    auth: { storage: CFG.recordarSesion ? localStorage : sessionStorage, persistSession: true, autoRefreshToken: true }
  });
}
const almacen = NUBE ? nube : local;

// ---------- Estado ----------
let fotos = [];            // { id, nombre, fav, fecha, tipo, url, mini }
let cartas = [];           // { id, titulo, texto, fecha, ext, nombreArchivo }
let filtro = "todas";
let indiceVisor = -1;
let vista = "menu";
let cartaAbierta = null;
let cartaEditando = null;
let urlArchivo = null;
let subiendo = false, sincronizando = false;

const galeria = $("galeria"), vacio = $("vacio"), contador = $("contador");
const visor = $("visor"), vImg = $("vImg"), vVid = $("vVid"), vFav = $("vFav"), vCerrar = $("vCerrar");
const mLeer = $("mLeer"), mEditar = $("mEditar");

const estaBloqueado = () => document.body.classList.contains("bloqueado");
const hayVentana = () => !visor.hidden || !mLeer.hidden || !mEditar.hidden;
function sinScroll() { document.body.classList.toggle("sin-scroll", hayVentana()); }
function avisar(texto, ms = 2400) {
  const a = $("aviso");
  a.textContent = texto;
  a.classList.add("ver");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => a.classList.remove("ver"), ms);
}
const fmtFecha = ms => new Date(ms).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" });

// ---------- Navegación entre menú, recuerdos y cartas ----------
function mostrar(v) {
  if (!["menu", "recuerdos", "cartas"].includes(v)) v = "menu";
  vista = v;
  document.querySelectorAll(".vista").forEach(s => (s.hidden = s.dataset.vista !== v));
  $("btnAtras").hidden = v === "menu";
  if (v === "recuerdos") dibujar(new Set(fotos.map(f => f.id)));
  if (v === "cartas") renderCartas();
  window.scrollTo(0, 0);
  if (v !== "menu") sincronizar();
}
function ir(v) {
  const h = v === "menu" ? "" : v;
  if (location.hash.slice(1) === h) mostrar(v); else location.hash = h;
}
function aplicarHash() { if (!estaBloqueado()) mostrar(location.hash.slice(1)); }
window.addEventListener("hashchange", aplicarHash);

document.querySelectorAll("[data-ir]").forEach(b => b.addEventListener("click", () => ir(b.dataset.ir)));
$("btnAtras").addEventListener("click", () => ir("menu"));
$("btnSalir").addEventListener("click", async () => {
  try { await almacen.salir(); } catch (e) {}
  history.replaceState(null, "", location.pathname + location.search);
  location.reload();
});

function actualizarMenu() {
  const n = fotos.length, c = cartas.length;
  $("cuentaRecuerdos").textContent = n ? `${n} ${n === 1 ? "recuerdo" : "recuerdos"}` : "Fotos y videos";
  $("cuentaCartas").textContent = c ? `${c} ${c === 1 ? "carta" : "cartas"}` : "Lo que nos escribimos";
}

// ================= RECUERDOS =================
function visibles() {
  return fotos.filter(f =>
    filtro === "favoritas" ? f.fav :
    filtro === "fotos" ? f.tipo === "imagen" :
    filtro === "videos" ? f.tipo === "video" : true);
}
const MENSAJES_VACIO = {
  todas:     ["Aún no hay recuerdos", "Toca “Subir fotos o videos” para empezar."],
  fotos:     ["No hay fotos todavía", "Sube una foto y aparecerá aquí."],
  videos:    ["No hay videos todavía", "Sube un video y aparecerá aquí."],
  favoritas: ["Aún no hay favoritos", "Toca el corazón de un recuerdo y aparecerá aquí."]
};

function dibujar(nuevas = new Set()) {
  const lista = visibles();
  galeria.innerHTML = "";

  lista.forEach((f, i) => {
    const esVideo = f.tipo === "video";
    const tile = document.createElement("div");
    tile.className = "foto";
    tile.dataset.id = f.id;
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", (esVideo ? "Ver video " : "Abrir foto ") + f.nombre);
    if (nuevas.has(f.id)) tile.style.animationDelay = (i % 12) * 40 + "ms";
    else tile.style.animation = "none";

    let media;
    if (esVideo) {
      media = document.createElement("video");
      media.src = f.url + "#t=0.1";
      media.muted = true; media.preload = "metadata"; media.playsInline = true;
      media.setAttribute("aria-hidden", "true");
    } else {
      media = document.createElement("img");
      media.src = f.mini || f.url; media.alt = f.nombre; media.loading = "lazy"; media.decoding = "async";
    }
    tile.append(media);

    if (esVideo) {
      const p = document.createElement("span");
      p.className = "play"; p.textContent = "▶"; tile.append(p);
    }

    const est = document.createElement("button");
    est.className = "estrella" + (f.fav ? " on" : "");
    est.textContent = f.fav ? "♥" : "♡";
    est.setAttribute("aria-label", "Marcar como favorito");
    est.addEventListener("click", e => { e.stopPropagation(); alternarFav(f.id); });
    tile.append(est);

    tile.addEventListener("click", () => abrirVisor(i));
    tile.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirVisor(i); } });
    galeria.append(tile);
  });

  const [t, p] = MENSAJES_VACIO[filtro];
  vacio.hidden = lista.length > 0;
  vacio.querySelector("h2").textContent = t;
  vacio.querySelector("p").textContent = p;

  const nf = fotos.filter(f => f.tipo === "imagen").length, nv = fotos.length - nf;
  contador.textContent = fotos.length
    ? `♥ ${fotos.length} ${fotos.length === 1 ? "recuerdo" : "recuerdos"} juntos · ${nf} ${nf === 1 ? "foto" : "fotos"} y ${nv} ${nv === 1 ? "video" : "videos"} ♥`
    : "";
  actualizarMenu();
}

// ---------- Subir fotos y videos ----------
async function agregar(archivos) {
  if (estaBloqueado() || vista !== "recuerdos" || subiendo) return;
  const validos = [...archivos].filter(a => /^(image|video)\//.test(a.type));
  if (!validos.length) return avisar("Elige fotos o videos");

  subiendo = true;
  const nuevas = new Set();
  let fallidas = 0, pesados = 0, n = 0;
  for (const a of validos) {
    n++;
    if (NUBE) avisar(`Subiendo ${n} de ${validos.length}…`, 180000);
    try {
      const f = await almacen.subirFoto(a);
      if (!fotos.some(x => x.id === f.id)) fotos.unshift(f);
      nuevas.add(f.id);
    } catch (e) {
      if (e && e.limite) pesados++; else fallidas++;
    }
  }
  subiendo = false;
  if (nuevas.size) dibujar(nuevas);

  const msg = [];
  if (nuevas.size) msg.push(nuevas.size === 1 ? "Recuerdo guardado ♥" : `${nuevas.size} recuerdos guardados ♥`);
  if (pesados) msg.push(`${pesados} pesan más de ${MAX_MB} MB`);
  if (fallidas) msg.push(`${fallidas} no se pudieron guardar`);
  avisar(msg.join(". "), 4500);
}

$("btnSubir").addEventListener("click", () => $("archivo").click());
$("archivo").addEventListener("change", e => { agregar(e.target.files); e.target.value = ""; });

// Arrastrar y soltar (computadora)
let contadorArrastre = 0;
window.addEventListener("dragenter", e => {
  if (estaBloqueado() || vista !== "recuerdos") return;
  if (![...e.dataTransfer.types].includes("Files")) return;
  contadorArrastre++; $("soltar").classList.add("activo");
});
window.addEventListener("dragleave", () => {
  if (--contadorArrastre <= 0) { contadorArrastre = 0; $("soltar").classList.remove("activo"); }
});
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
  e.preventDefault(); contadorArrastre = 0;
  $("soltar").classList.remove("activo");
  agregar(e.dataTransfer.files);
});

// ---------- Favoritos y eliminar ----------
async function alternarFav(id) {
  const f = fotos.find(x => x.id === id);
  f.fav = !f.fav;
  dibujar();
  if (!visor.hidden) {
    if (filtro === "favoritas" && !f.fav) ajustarVisorTrasQuitar();
    else pintarFavVisor();
  }
  try { await almacen.guardarFav(f); }
  catch (e) {
    f.fav = !f.fav; dibujar();
    if (!visor.hidden) pintarFavVisor();
    avisar("No se pudo guardar el cambio");
  }
}
async function eliminar(id) {
  const f = fotos.find(x => x.id === id);
  try { await almacen.borrarFoto(f); }
  catch (e) { avisar("No se pudo eliminar"); return false; }
  const tile = galeria.querySelector(`[data-id="${id}"]`);
  if (tile) { tile.style.animation = ""; tile.classList.add("sale"); await new Promise(r => setTimeout(r, 280)); }
  fotos = fotos.filter(x => x.id !== id);
  dibujar();
  avisar("Recuerdo eliminado");
  return true;
}

// ---------- Filtros y tamaño ----------
document.querySelectorAll("#vRecuerdos .tab").forEach(t =>
  t.addEventListener("click", () => {
    document.querySelector("#vRecuerdos .tab.activa").classList.remove("activa");
    t.classList.add("activa");
    filtro = t.dataset.filtro;
    dibujar(new Set(visibles().map(f => f.id)));
  })
);
$("tamano").addEventListener("input", e =>
  document.documentElement.style.setProperty("--tam", e.target.value + "px")
);

// ---------- Visor (fotos y videos) ----------
function abrirVisor(i) { indiceVisor = i; visor.hidden = false; actualizarVisor(); sinScroll(); vCerrar.focus(); }
function cerrarVisor() {
  visor.hidden = true; indiceVisor = -1;
  vVid.pause(); vVid.removeAttribute("src"); vVid.load();
  sinScroll();
}
function pintarFavVisor() {
  const f = visibles()[indiceVisor];
  if (f) vFav.textContent = f.fav ? "♥ Favorito" : "♡ Favorito";
}
function actualizarVisor() {
  const f = visibles()[indiceVisor];
  if (!f) return cerrarVisor();
  const esVideo = f.tipo === "video";
  vVid.pause();
  vImg.hidden = esVideo; vVid.hidden = !esVideo;
  if (esVideo) {
    vVid.src = f.url;
    vVid.play().catch(() => {});
  } else {
    vVid.removeAttribute("src"); vVid.load();
    vImg.src = f.url; vImg.alt = f.nombre;
  }
  const el = esVideo ? vVid : vImg;
  el.classList.remove("cambia"); void el.offsetWidth; el.classList.add("cambia");
  pintarFavVisor();
}
function moverVisor(d) {
  const n = visibles().length;
  if (!n) return;
  indiceVisor = (indiceVisor + d + n) % n;
  actualizarVisor();
}
function ajustarVisorTrasQuitar() {
  const n = visibles().length;
  if (n <= 0) return cerrarVisor();
  indiceVisor = Math.min(indiceVisor, n - 1);
  actualizarVisor();
}

$("vCerrar").addEventListener("click", cerrarVisor);
$("vPrev").addEventListener("click", () => moverVisor(-1));
$("vNext").addEventListener("click", () => moverVisor(1));
vFav.addEventListener("click", () => alternarFav(visibles()[indiceVisor].id));
$("vBorrar").addEventListener("click", async () => {
  const f = visibles()[indiceVisor];
  vVid.pause();
  if (await eliminar(f.id)) ajustarVisorTrasQuitar();
});
visor.addEventListener("click", e => { if (e.target === visor) cerrarVisor(); });

// ================= CARTAS =================
function renderCartas() {
  const lista = $("listaCartas");
  lista.innerHTML = "";
  cartas.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "carta";
    b.style.animationDelay = Math.min(i, 10) * 50 + "ms";
    const sello = document.createElement("span"); sello.className = "carta-sello"; sello.textContent = "♥";
    const t = document.createElement("h3"); t.textContent = c.titulo;
    const d = document.createElement("time"); d.textContent = fmtFecha(c.fecha);
    b.append(sello, t, d);
    if (c.nombreArchivo) {
      const tipo = document.createElement("span");
      tipo.className = "carta-tipo"; tipo.textContent = c.ext === "pdf" ? "PDF" : "WORD";
      b.append(tipo);
    }
    const p = document.createElement("p");
    p.textContent = c.texto || "📎 " + (c.nombreArchivo || "");
    b.append(p);
    b.addEventListener("click", () => leerCarta(c.id));
    lista.append(b);
  });
  $("vacioCartas").hidden = cartas.length > 0;
  actualizarMenu();
}

function limpiarArchivoAbierto() {
  $("lPdf").hidden = true; $("lPdf").removeAttribute("src");
  if (urlArchivo) { URL.revokeObjectURL(urlArchivo); urlArchivo = null; }
}

async function leerCarta(id) {
  const c = cartas.find(x => x.id === id);
  if (!c) return;
  cartaAbierta = id;
  limpiarArchivoAbierto();
  $("lTitulo").textContent = c.titulo;
  $("lFecha").textContent = fmtFecha(c.fecha) + (c.editada ? " (editada)" : "");
  $("lTexto").textContent = c.texto || "";
  $("lTexto").hidden = !c.texto;
  $("lArchivo").hidden = !c.nombreArchivo;
  if (c.nombreArchivo) {
    $("lArchivoNombre").textContent = "📎 " + c.nombreArchivo;
    $("lAbrir").disabled = $("lDescargar").disabled = true;
  }
  mLeer.hidden = false;
  mLeer.querySelector(".hoja").scrollTop = 0;
  sinScroll();
  $("lCerrar").focus();

  if (c.nombreArchivo) {
    try {
      const blob = await almacen.archivoCarta(c);
      if (cartaAbierta !== id) return;
      urlArchivo = URL.createObjectURL(blob);
      $("lAbrir").disabled = $("lDescargar").disabled = false;
      // Vista previa del PDF solo en computadora (en el celular se usa "Abrir archivo")
      if (c.ext === "pdf" && matchMedia("(hover: hover) and (pointer: fine)").matches) {
        $("lPdf").src = urlArchivo; $("lPdf").hidden = false;
      }
    } catch (e) { avisar("No se pudo cargar el archivo"); }
  }
}
function cerrarLeer() {
  mLeer.hidden = true; cartaAbierta = null; sinScroll();
  limpiarArchivoAbierto();
}

function abrirEditor(id = null) {
  cartaEditando = id;
  const c = id && cartas.find(x => x.id === id);
  $("eCabecera").textContent = c ? "Editar carta" : "Nueva carta";
  $("eTitulo").value = c ? c.titulo : "";
  $("eTexto").value = c ? c.texto : "";
  const soloArchivo = !!(c && c.nombreArchivo && !c.texto);   // PDF/Word sin texto: solo se cambia el título
  $("eTexto").hidden = soloArchivo;
  $("eTexto").required = !soloArchivo;
  mLeer.hidden = true;
  mEditar.hidden = false;
  sinScroll();
  $("eTitulo").focus();
}
function cerrarEditor() {
  mEditar.hidden = true; sinScroll();
  if (cartaEditando) leerCarta(cartaEditando);
  cartaEditando = null;
}

$("btnNuevaCarta").addEventListener("click", () => abrirEditor());
$("lCerrar").addEventListener("click", cerrarLeer);
$("lEditar").addEventListener("click", () => abrirEditor(cartaAbierta));
$("eCancelar").addEventListener("click", cerrarEditor);
mLeer.addEventListener("click", e => { if (e.target === mLeer) cerrarLeer(); });

$("lBorrar").addEventListener("click", async () => {
  if (!confirm("¿Eliminar esta carta? No se puede recuperar.")) return;
  const c = cartas.find(x => x.id === cartaAbierta);
  try { await almacen.borrarCarta(c); }
  catch (e) { return avisar("No se pudo eliminar la carta"); }
  cartas = cartas.filter(x => x.id !== c.id);
  cerrarLeer(); renderCartas();
  avisar("Carta eliminada");
});

$("formCarta").addEventListener("submit", async e => {
  e.preventDefault();
  const titulo = $("eTitulo").value.trim(), texto = $("eTexto").value.trim();
  let c = cartaEditando && cartas.find(x => x.id === cartaEditando);
  if (!titulo || (!texto && !(c && c.nombreArchivo))) return;
  try {
    if (c) { c.titulo = titulo; c.texto = texto; c.editada = Date.now(); await almacen.actualizarCarta(c); }
    else { c = await almacen.crearCarta({ titulo, texto }); cartas.push(c); }
  } catch (err) { return avisar("No se pudo guardar la carta"); }
  cartas.sort((a, b) => b.fecha - a.fecha);
  const id = c.id, editaba = !!cartaEditando;
  mEditar.hidden = true; cartaEditando = null; sinScroll();
  renderCartas();
  avisar("Carta guardada ♥");
  if (editaba) leerCarta(id);
});

// ---------- Subir cartas desde archivos (.txt, .pdf, .doc, .docx) ----------
const EXT_CARTAS = ["txt", "pdf", "doc", "docx"];

async function leerTxt(archivo) {
  const buf = await archivo.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder("windows-1252").decode(buf); }   // txt viejos de Windows con tildes
}

async function subirCartas(archivos) {
  let ok = 0, mal = 0, pesados = 0;
  const lista = [...archivos];
  for (const a of lista) {
    const ext = (a.name.split(".").pop() || "").toLowerCase();
    if (!EXT_CARTAS.includes(ext)) { mal++; continue; }
    if (NUBE) avisar("Subiendo carta…", 180000);
    const meta = {
      ext, texto: "",
      titulo: a.name.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim().slice(0, 80) || "Carta"
    };
    try {
      let adjunto = null;
      if (ext === "txt") {
        meta.texto = (await leerTxt(a)).trim();
        if (!meta.texto) { mal++; continue; }
      } else {
        adjunto = a; meta.nombreArchivo = a.name;
        if (ext === "docx" && window.mammoth) {          // sacar el texto del Word para mostrarlo aquí
          try { meta.texto = ((await mammoth.extractRawText({ arrayBuffer: await a.arrayBuffer() })).value || "").trim(); }
          catch (e) {}
        }
      }
      cartas.push(await almacen.crearCarta(meta, adjunto));
      ok++;
    } catch (e) { if (e && e.limite) pesados++; else mal++; }
  }
  cartas.sort((a, b) => b.fecha - a.fecha);
  renderCartas();
  if (ok && !mal && !pesados) avisar(ok === 1 ? "Carta subida ♥" : `${ok} cartas subidas ♥`);
  else if (ok) avisar(`${ok} subidas. ${mal + pesados} no se pudieron guardar`, 4500);
  else if (pesados) avisar(`El archivo pesa más de ${MAX_MB} MB`, 4500);
  else avisar("Solo se aceptan archivos .txt, .pdf, .doc y .docx", 4500);
}

$("btnSubirCarta").addEventListener("click", () => $("archivoCarta").click());
$("archivoCarta").addEventListener("change", e => { subirCartas(e.target.files); e.target.value = ""; });
$("lAbrir").addEventListener("click", () => { if (urlArchivo) window.open(urlArchivo, "_blank"); });
$("lDescargar").addEventListener("click", () => {
  const c = cartas.find(x => x.id === cartaAbierta);
  if (!c || !urlArchivo) return;
  const a = document.createElement("a");
  a.href = urlArchivo; a.download = c.nombreArchivo;
  document.body.append(a); a.click(); a.remove();
});

// ---------- Teclado general ----------
document.addEventListener("keydown", e => {
  if (!mEditar.hidden) { if (e.key === "Escape") cerrarEditor(); return; }
  if (!mLeer.hidden)   { if (e.key === "Escape") cerrarLeer(); return; }
  if (visor.hidden) return;
  if (e.key === "Escape") cerrarVisor();
  if (e.key === "ArrowLeft") moverVisor(-1);
  if (e.key === "ArrowRight") moverVisor(1);
});

// ================= CARGA Y SINCRONIZACIÓN =================
async function cargarTodo() {
  try {
    const [fs, cs] = await Promise.all([almacen.listarFotos(), almacen.listarCartas()]);
    fotos = fs; cartas = cs;
  } catch (e) {
    avisar("No se pudieron cargar los recuerdos. Revisa tu internet.", 4500);
  }
  actualizarMenu();
  renderCartas();
  if (vista === "recuerdos") dibujar(new Set(fotos.map(f => f.id)));
}

// Trae lo que subió la otra persona (solo en la nube)
async function sincronizar() {
  if (!NUBE || estaBloqueado() || sincronizando || subiendo || hayVentana() || document.hidden) return;
  sincronizando = true;
  try {
    const [fs, cs] = await Promise.all([nube.listarFotos(), nube.listarCartas()]);
    if (subiendo || hayVentana()) return;
    const sigF = l => l.map(x => x.id + (x.fav ? 1 : 0)).join("|");
    const sigC = l => l.map(x => x.id + ":" + (x.editada || 0)).join("|");
    if (sigF(fs) !== sigF(fotos)) {
      const viejos = new Set(fotos.map(f => f.id));
      fotos = fs;
      if (vista === "recuerdos") dibujar(new Set(fs.filter(f => !viejos.has(f.id)).map(f => f.id)));
      else actualizarMenu();
    }
    if (sigC(cs) !== sigC(cartas)) { cartas = cs; renderCartas(); }
  } catch (e) { /* sin conexión: se intenta de nuevo luego */ }
  finally { sincronizando = false; }
}
let sincronizacionActiva = false;
function activarSincronizacion() {
  if (!NUBE || sincronizacionActiva) return;
  sincronizacionActiva = true;
  setInterval(sincronizar, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sincronizar(); });
}

// ---------- Pétalos que caen ----------
(function petalos() {
  const cont = $("petalos");
  const cantidad = window.innerWidth < 640 ? 8 : 16;
  for (let i = 0; i < cantidad; i++) {
    const p = document.createElement("span");
    p.className = "petalo";
    const t = 10 + Math.random() * 16;
    p.style.width = t + "px";
    p.style.height = t * 1.2 + "px";
    p.style.left = Math.random() * 100 + "%";
    p.style.animationDuration = 9 + Math.random() * 9 + "s";
    p.style.animationDelay = -Math.random() * 14 + "s";
    cont.append(p);
  }
})();

// ---------- La carta con clave ----------
(async function candado() {
  const cand = $("candado"), sobre = $("sobre"), papel = $("papel");
  const cajas = $("clave"), error = $("error"), teclado = $("teclado");
  const partes = document.querySelectorAll("#barra, #principal");

  if (!NUBE) $("modoLocal").hidden = false;

  document.body.classList.add("bloqueado");
  partes.forEach(p => (p.inert = true));
  cand.classList.add("comprobando");

  function desbloquear() {
    document.body.classList.remove("bloqueado");
    partes.forEach(p => (p.inert = false));
    cargarTodo();
    activarSincronizacion();
  }

  let yaEntro = false;
  try { yaEntro = await almacen.haySesion(); } catch (e) {}
  if (yaEntro) { cand.remove(); desbloquear(); aplicarHash(); return; }
  cand.classList.remove("comprobando");

  let valor = "", verificando = false;
  const casillas = [];
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("span");
    c.className = "casilla"; cajas.append(c); casillas.push(c);
  }
  [1,2,3,4,5,6,7,8,9,"",0,"⌫"].forEach(t => {
    if (t === "") return teclado.append(document.createElement("span"));
    const b = document.createElement("button");
    b.type = "button"; b.textContent = t;
    b.setAttribute("aria-label", t === "⌫" ? "Borrar" : "Número " + t);
    b.addEventListener("click", () => (t === "⌫" ? borrar() : poner(String(t))));
    teclado.append(b);
  });

  function pintar() {
    casillas.forEach((c, i) => {
      c.textContent = i < valor.length ? "♥" : "";
      c.classList.toggle("llena", i < valor.length);
      c.classList.toggle("activa", i === valor.length);
    });
  }
  function poner(n) {
    if (verificando || valor.length >= 6) return;
    error.textContent = "";
    valor += n; pintar();
    if (valor.length === 6) setTimeout(revisar, 250);
  }
  function borrar() { if (verificando) return; valor = valor.slice(0, -1); error.textContent = ""; pintar(); }

  async function revisar() {
    verificando = true;
    error.textContent = NUBE ? "Revisando…" : "";
    try {
      await almacen.entrar(valor);
      error.textContent = "";
      entrar();
    } catch (e) {
      const mala = e && (e.status === 400 || e.code === "invalid_credentials");
      error.textContent = mala ? "Esa no es la clave, intenta otra vez"
        : e && e.status === 429 ? "Demasiados intentos, espera un momento"
        : "No se pudo conectar. Revisa tu internet";
      papel.classList.remove("sacude"); void papel.offsetWidth; papel.classList.add("sacude");
      valor = ""; pintar();
    } finally { verificando = false; }
  }

  function entrar() {
    cand.classList.add("saliendo");
    setTimeout(() => {
      cand.remove();
      history.replaceState(null, "", location.pathname + location.search);
      desbloquear();
      mostrar("menu");
      avisar("Bienvenidos a nuestros recuerdos ♥");
    }, 750);
  }

  sobre.addEventListener("click", () => {
    sobre.classList.add("abriendo");
    $("pista").hidden = true;
    setTimeout(() => { sobre.hidden = true; papel.hidden = false; pintar(); }, 800);
  });

  document.addEventListener("keydown", e => {
    if (papel.hidden || !document.body.classList.contains("bloqueado")) return;
    if (/^[0-9]$/.test(e.key)) poner(e.key);
    else if (e.key === "Backspace") borrar();
  });
})();

// ---------- Gestos en celular: desliza para cambiar o cerrar ----------
(function gestos() {
  let x0 = 0, y0 = 0, ignorar = false;
  visor.addEventListener("touchstart", e => {
    ignorar = e.target === vVid;   // no interferir con la barra del video
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  visor.addEventListener("touchend", e => {
    if (ignorar) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) moverVisor(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) cerrarVisor();
  }, { passive: true });
})();

// ---------- Inicio ----------
aplicarHash();
