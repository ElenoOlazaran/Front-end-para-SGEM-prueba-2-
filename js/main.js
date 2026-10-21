/* ============================================================
   SISTEMA DE CONTROL DE EVALUACIÓN Y CALIFICACIÓN PARA DOCENTES
   Motor SPA + Consumo de datos (fetch) desde backend Java local
   ============================================================ */

/* ==========================================
   1. RUTAS DEL SERVIDOR (Configuración genérica)
   ==========================================
   Estas constantes son el punto ÚNICO de integración con el backend en Java.
   Cuando el equipo configure el servidor local, basta con reemplazar
   'URL_AQUI' por la ruta real (ej. 'http://localhost:8080/api/grupos').
   Nunca copies estas rutas dentro de las funciones: siempre se consumen
   desde estas constantes. */
const URL_API_GRUPOS       = 'URL_AQUI'; // GET/POST: grupos del docente (incluye indicador de modelo PRIMARIA/SECUNDARIA)
const URL_API_ESCUELAS     = 'URL_AQUI'; // GET/POST: instituciones registradas
const URL_API_CICLOS       = 'URL_AQUI'; // GET/POST: ciclos escolares (activos y archivados)
const URL_API_AGENDA       = 'URL_AQUI'; // GET: clases del día (clase en curso + próximas)
const URL_API_RECORDATORIOS= 'URL_AQUI'; // GET: notas / recordatorios globales
const URL_API_ALUMNOS      = 'URL_AQUI'; // GET: alumnos inscritos (Control Diario / Dashboard)
const URL_API_DASHBOARD    = 'URL_AQUI'; // GET: resumen del grupo activo (promedio, horario, tops, notas, archivos)
const URL_API_HISTORIAL    = 'URL_AQUI'; // GET: sábana de calificaciones de ciclos cerrados

/* Cachés locales de la última respuesta del servidor.
   Evitan nuevas peticiones para filtros o búsquedas en vivo. */
let _cacheGrupos = [];

/* Contexto de navegación interna: el grupo que abrió el último dashboard.
   Permite fijar títulos y parámetros sin recargar la página. */
let _grupoActivo = null;

/* Contratos de datos esperados por el backend (solo documentación):
   - Grupo:     [{ id, nombre, escuela, modelo: 'PRIMARIA'|'SECUNDARIA', materias: [{ nombre, color }] }]
   - Escuela:   [{ id, nombre, cct, ubicacion, totalGrupos }]
   - Ciclo:     [{ id, nombre, activo, periodo, totalGrupos }]
   - Clase:     { claseActual: {...} | null, proximas: [ {...} ] }
   - Recordatorio: [{ id, grupo, texto, urgente }]
   Si el servidor responde [] (arreglo vacío), la UI dibuja un estado vacío amigable. */


/* ==========================================
   2. MOTOR DE NAVEGACIÓN SPA
   ==========================================
   Inyecta los fragmentos HTML dentro del contenedor principal
   SIN recargar la página (el shell de index.html nunca desaparece,
   por lo que la pantalla jamás se pone en blanco). */
async function cargarVista(nombreVista) {
    try {
        // 1. Estado visual del menú: quitar "activo" a todos y asignarlo al botón clickeado
        document.querySelectorAll('.menu-item').forEach(btn => btn.classList.remove('activo'));
        const botonActivo = document.getElementById(`btn-${nombreVista}`);
        if (botonActivo) botonActivo.classList.add('activo');

        // 2. Petición asíncrona del fragmento HTML de la vista
        const respuesta = await fetch(`vistas/${nombreVista}.html`);
        if (!respuesta.ok) throw new Error(`No se encontró la vista: ${nombreVista}.html`);
        const html = await respuesta.text();

        // 3. Inyección del HTML en el cascarón principal
        document.getElementById('contenido-principal').innerHTML = html;

        // 4. Disparar la carga de datos reales (fetch al backend Java) de esta vista
        ejecutarCargaDeDatos(nombreVista);

    } catch (error) {
        console.error("Error en la navegación SPA:", error);
        document.getElementById('contenido-principal').innerHTML = `
            <div class="estado-error">
                ⚠️ <strong>Error de Carga:</strong> no se pudo cargar el módulo <b>${nombreVista}</b>.
                Verifica que el archivo exista en la carpeta 'vistas'.
            </div>`;
    }
}

/**
 * Despachador de cargas: al terminar la inyección del HTML de cada vista,
 * lanza la(s) petición(es) fetch() correspondientes para poblar sus contenedores.
 */
function ejecutarCargaDeDatos(nombreVista) {
    switch (nombreVista) {
        case 'inicio':          cargarAgendaInicio();       break;
        case 'grupos':          cargarGrupos();             break;
        case 'escuelas':        cargarEscuelas();           break;
        case 'ciclos':          cargarCiclos();             break;
        case 'diario':          prepararControlDiario();    break;
        case 'dashboard-grupo': cargarContenidoDashboardGrupo(); break;
        // 'reportes' carga sus listas bajo demanda al usar el embudo de búsqueda
    }
}

/** Arranque de la aplicación: abre el Dashboard de Inicio por defecto */
window.onload = () => {
    cargarVista('inicio');
};


/* ==========================================
   3. HELPERS DE ESTADO (Loaders / Vacío / Error)
   ==========================================
   Estos tres helpers inyectan/descartan HTML directamente sobre el
   contenedor destino, de modo que CADA módulo usa la misma UX. */

/** Inyecta el texto "Cargando..." con aro giratorio dentro del contenedor. */
function mostrarCargando(contenedor) {
    contenedor.innerHTML = `
        <div class="cargando">
            <div class="spinner"></div>
            <span>Cargando...</span>
        </div>`;
}

/** Reemplaza el loader cuando el servidor responde [] o no hay registros. */
function mostrarEstadoVacio(contenedor, titulo, detalle) {
    contenedor.innerHTML = `
        <div class="estado-vacio">
            <span class="icono-vacio">📭</span>
            <p class="titulo-vacio">${titulo || 'No hay registros por ahora'}</p>
            <p class="detalle-vacio">${detalle || 'Cuando registres información aquí, aparecerá automáticamente.'}</p>
        </div>`;
}

/** Reemplaza el loader cuando la petición al servidor falla. */
function mostrarEstadoError(contenedor, detalle) {
    contenedor.innerHTML = `
        <div class="estado-error">
            ⚠️ <strong>No se pudo conectar con el servidor.</strong><br>${detalle || 'Revisa que el backend esté activo.'}
        </div>`;
}

/* ==========================================
   4. AYUDANTE GENÉRICO DE FETCH
   ==========================================
   Flujo estándar: loader en pantalla -> fetch a la ruta API ->
   respuesta [] = estado vacío | con datos = render con la función recibida |
   fallo = estado de error. Cero Adobe de fechas, cero bloqueos. */
async function cargarDatosJSON(rutaAPI, contenedorId, funcionRender, tituloVacio, detalleVacio) {
    const contenedor = document.getElementById(contenedorId);
    if (!contenedor) return; // La vista pudo haber cambiado mientras respondía el servidor

    mostrarCargando(contenedor); // Paso 1: avisar al usuario que hay trabajo en curso

    try {
        // Paso 2: petición asíncrona al backend Java
        const respuesta = await fetch(rutaAPI);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const datos = await respuesta.json();

        // Paso 3: decidir qué dibujar según el contenido del JSON
        if (!Array.isArray(datos) || datos.length === 0) {
            mostrarEstadoVacio(contenedor, tituloVacio, detalleVacio); // Arreglo vacío []
        } else {
            funcionRender(datos, contenedor); // Pintar los datos reales
        }
    } catch (error) {
        console.error('Error al consumir ' + rutaAPI + ':', error);
        mostrarEstadoError(contenedor);
    }
}


/* ==========================================
   5. MIS GRUPOS: Carga y render dinámico
   ==========================================
   El backend Java envía en cada grupo un indicador: 
     "modelo": "PRIMARIA"   -> tarjeta dorada con múltiples chips de materias
     "modelo": "SECUNDARIA" -> tarjeta guinda con un único chip de materia
   El render es condicional (if/else) según ese indicador. */
function cargarGrupos() {
    cargarDatosJSON(URL_API_GRUPOS, 'contenedor-grupos', renderizarGrupos,
        'Aún no tienes grupos registrados',
        'Pulsa "+ Crear Nuevo Grupo" para empezar a organizar tus salones.');
    poblarSelectEscuelas(); // El modal de creación necesita la lista real de instituciones
}

/**
 * Rellena el select del modal "Crear Grupo" con las escuelas reales del servidor.
 * Reutiliza el patrón: carga -> opciones | mensaje vacío si el servidor no trae datos.
 */
async function poblarSelectEscuelas() {
    const select = document.getElementById('select-escuela-nuevo-grupo');
    if (!select) return;

    try {
        const respuesta = await fetch(URL_API_ESCUELAS);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const escuelas = await respuesta.json();

        if (Array.isArray(escuelas) && escuelas.length > 0) {
            select.innerHTML = '<option disabled selected>Selecciona una escuela...</option>' +
                escuelas.map(e => `<option value="${e.id || ''}">${e.nombre}</option>`).join('');
        } else {
            select.innerHTML = '<option disabled selected>No hay escuelas registradas. Créalas primero en "Escuelas".</option>';
        }
    } catch (error) {
        console.error('Error al poblar el selector de escuelas:', error);
        select.innerHTML = '<option disabled selected>Error al conectar con el servidor</option>';
    }
}

/** Función iterativa: recorre el arreglo del servidor y arma la cuadrícula. */
function renderizarGrupos(listaGrupos) {
    const contenedor = document.getElementById('contenedor-grupos');
    contenedor.innerHTML = ''; // Limpia el loader antes de pintar

    // Guardamos la lista en caché para que el buscador filtre sin volver a llamar al servidor
    _cacheGrupos = listaGrupos;

    listaGrupos.forEach(grupo => {
        const tarjeta = crearTarjetaGrupo(grupo);
        contenedor.appendChild(tarjeta);
    });
}

/**
 * Crea UNA tarjeta adaptativa. Núcleo de la lógica híbrida Primaria/Secundaria:
 * - PRIMARIA (múltiples materias): borde superior dorado, chips apilados.
 * - SECUNDARIA (una materia): borde superior guinda, chip individual.
 */
function crearTarjetaGrupo(grupo) {
    const tarjeta = document.createElement('div');
    tarjeta.style = 'background: var(--fondo-tarjeta); border-radius: 12px; border: 1px solid var(--borde); padding: 25px; display: flex; flex-direction: column; box-shadow: 0 4px 6px rgba(0,0,0,0.05); animation: fadeIn 0.4s;';
    tarjeta.dataset.nombreGrupo = grupo.nombre || ''; // Para el buscador en vivo

    // Condicional del modelo educativo (viene indicado por el backend)
    if (grupo.modelo === 'PRIMARIA') {
        tarjeta.style.borderTop = '5px solid var(--dorado)';
    } else {
        tarjeta.style.borderTop = '5px solid var(--guinda)';
    }

    // Armar los chips de materias también de forma condicional
    let contenidoMaterias = '';
    if (grupo.materias && grupo.materias.length > 0) {
        if (grupo.modelo === 'PRIMARIA') {
            // Primaria: cada materia es un chip independiente (paleta alternada)
            const paleta = [
                ['#E0F2FE', '#0369A1', '#BAE6FD'],
                ['#D1FAE5', '#065F46', '#A7F3D0'],
                ['#FEF3C7', '#92400E', '#FDE68A']
            ];
            contenidoMaterias = grupo.materias.map((m, i) => {
                const c = paleta[i % paleta.length];
                return `<span style="background:${c[0]};color:${c[1]};border:1px solid ${c[2]};padding:6px 12px;border-radius:20px;font-size:13px;font-weight:bold;">📚 ${m.nombre}</span>`;
            }).join('');
            contenidoMaterias = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-content:flex-start;">${contenidoMaterias}</div>`;
        } else {
            // Secundaria: una sola materia, chip elegante en tonos guinda
            const m = grupo.materias[0];
            contenidoMaterias = `
                <div style="min-height:50px;">
                    <span style="background:#FCE7F3;color:#9D174D;border:1px solid #FBCFE8;padding:6px 12px;border-radius:20px;font-size:13px;font-weight:bold;display:inline-block;">📚 ${m.nombre}</span>
                </div>`;
        }
    } else {
        // El grupo aún no tiene materias asignadas en el servidor
        contenidoMaterias = '<div style="min-height:50px; font-size:13px; color:var(--texto-secundario); display:flex; align-items:center;">Sin materias asignadas aún.</div>';
    }

    tarjeta.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
            <h2 style="margin:0; font-size:24px; color:var(--texto-principal);">${grupo.nombre}</h2>
        </div>
        <p style="margin:0 0 15px 0; color:var(--texto-secundario); font-size:14px; font-weight:500;">🏛️ ${grupo.escuela || ''}</p>
        ${contenidoMaterias}
        <button style="width:100%; margin-top:15px; background:var(--fondo-app); color:var(--guinda); border:1px solid var(--borde); padding:12px; border-radius:8px; font-weight:bold; cursor:pointer; font-size:14px;">Abrir Dashboard ➔</button>
    `;

    // El dashboard recibe el objeto COMPLETO del grupo (sin recargar la página)
    tarjeta.querySelector('button').addEventListener('click', () => abrirDashboardGrupo(grupo));
    return tarjeta;
}

/** Buscador en vivo (sin recargas): filtra las tarjetas ya renderizadas del caché. */
function filtrarGrupos(termino) {
    const listaGrupos = _cacheGrupos || [];
    const contenedor = document.getElementById('contenedor-grupos');
    if (!contenedor) return;

    // 1. Estado nº1: el filtro está vacío -> repintar TODOS los grupos
    if (termino.trim() === '') {
        if (listaGrupos.length === 0) {
            mostrarEstadoVacio(contenedor, 'Aún no tienes grupos registrados', 'Crea tu primer grupo para empezar.');
        } else {
            renderizarGrupos(listaGrupos);
        }
        return;
    }

    // 2. Estado nº2: hay filtro -> separar coincidencias de descartados
    const term = termino.toLowerCase();
    const coincidentes = listaGrupos.filter(g =>
        (g.nombre || '').toLowerCase().includes(term) ||
        (g.escuela || '').toLowerCase().includes(term) ||
        (g.materias || []).some(m => (m.nombre || '').toLowerCase().includes(term))
    );

    // 3. Estado nº3: nadie coincide -> mensaje en línea en la cuadrícula
    if (coincidentes.length === 0) {
        contenedor.innerHTML = `
            <div class="estado-vacio">
                <span class="icono-vacio">🔍</span>
                <p class="titulo-vacio">Sin coincidencias para "${termino}"</p>
                <p class="detalle-vacio">Prueba con el nombre del grupo, la escuela o una materia.</p>
            </div>`;
    } else {
        renderizarGrupos(coincidentes);
    }
}


/* ==========================================
   6. ESCUELAS y CICLOS: Carga y render dinámico
   ========================================== */

function cargarEscuelas() {
    cargarDatosJSON(URL_API_ESCUELAS, 'contenedor-escuelas', (lista) => {
        const contenedor = document.getElementById('contenedor-escuelas');
        contenedor.innerHTML = '';
        // Itera el JSON real y agrega una tarjeta por cada escuela del backend
        lista.forEach(escuela => contenedor.appendChild(crearTarjetaEscuela(escuela)));
    }, 'No hay escuelas registradas', 'Pulsa "+ Registrar Nueva Escuela" para añadir tu primera institución.');
}

function crearTarjetaEscuela(escuela) {
    const tarjeta = document.createElement('div');
    tarjeta.style = 'background: var(--fondo-tarjeta); border-radius: 12px; border: 1px solid var(--borde); border-top: 5px solid var(--dorado); padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); animation: fadeIn 0.4s;';
    tarjeta.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; gap:10px;">
            <h2 style="margin:0; font-size:22px; color:var(--texto-principal);">${escuela.nombre}</h2>
            ${escuela.cct ? `<span style="background:#F3F4F6; color:var(--texto-secundario); font-size:12px; font-weight:bold; padding:4px 8px; border-radius:6px; white-space:nowrap;">CCT: ${escuela.cct}</span>` : ''}
        </div>
        <p style="margin:0 0 15px 0; color:var(--texto-secundario); font-size:13px;">📍 ${escuela.ubicacion || 'Sin ubicación registrada'}</p>
        <div style="background:var(--fondo-app); padding:10px; border-radius:8px; margin-bottom:15px;">
            <span style="display:block; font-size:12px; color:var(--texto-secundario); font-weight:bold;">GRUPOS ASIGNADOS AQUÍ:</span>
            <span style="display:block; font-size:18px; color:var(--guinda); font-weight:bold;">${escuela.totalGrupos || 0} ${escuela.totalGrupos === 1 ? 'Grupo' : 'Grupos'}</span>
        </div>
        <button style="width:100%; background:white; color:var(--texto-principal); border:1px solid var(--borde); padding:10px; border-radius:8px; font-weight:bold; cursor:pointer; font-size:13px; transition:0.2s;"
            onmouseover="this.style.background='var(--fondo-app)'" onmouseout="this.style.background='white'">
            ✏️ Editar Datos
        </button>
    `;
    // Pasa el objeto real de la escuela al modal de edición (sin datos falsos)
    tarjeta.querySelector('button').addEventListener('click', () =>
        abrirModalEditarEscuela(escuela.nombre, escuela.cct, escuela.ubicacion));
    return tarjeta;
}

function cargarCiclos() {
    cargarDatosJSON(URL_API_CICLOS, 'contenedor-ciclos', (lista) => {
        const contenedor = document.getElementById('contenedor-ciclos');
        contenedor.innerHTML = '';
        lista.forEach(ciclo => contenedor.appendChild(crearTarjetaCiclo(ciclo)));
    }, 'No hay ciclos escolares registrados', 'Pulsa "+ Agregar Nuevo Ciclo" para iniciar un periodo académico.');
}

function crearTarjetaCiclo(ciclo) {
    const tarjeta = document.createElement('div');
    const activo = !!ciclo.activo; // El backend decide si el ciclo está vigente
    tarjeta.style = `background: var(--fondo-tarjeta); border-radius: 12px; border: 1px solid var(--borde); border-top: 5px solid ${activo ? 'var(--verde-bandera)' : 'var(--texto-secundario)'}; padding: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); animation: fadeIn 0.4s;${activo ? '' : ' opacity: 0.85;'}`;
    tarjeta.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <span style="background:${activo ? '#D1FAE5' : 'var(--borde)'}; color:${activo ? '#065F46' : 'var(--texto-secundario)'}; padding:6px 12px; border-radius:20px; font-size:12px; font-weight:bold;">${activo ? '📌 Ciclo Actual' : '🔒 Archivado'}</span>
            <span style="color:var(--texto-secundario); font-size:13px; font-weight:bold;">${ciclo.periodo || ''}</span>
        </div>
        <h2 style="margin:0 0 10px 0; font-size:24px; color:var(--texto-principal);">${ciclo.nombre}</h2>
        <p style="margin:0 0 20px 0; color:var(--texto-secundario); font-size:14px; font-weight:500;">👥 ${ciclo.totalGrupos || 0} ${ciclo.activo ? 'grupos activos en este periodo.' : 'grupos archivados.'}</p>
        <button style="width:100%; background:var(--fondo-app); color:var(--texto-principal); border:1px solid var(--borde); padding:12px; border-radius:8px; font-weight:bold; cursor:pointer; font-size:14px; transition:0.2s;" onmouseover="this.style.background='#E5E7EB'" onmouseout="this.style.background='var(--fondo-app)'">⚙️ ${activo ? 'Editar / Administrar' : 'Ver Historial ➔'}</button>
    `;
    // Solo los ciclos activos abren el panel de edición; los cerrados van a historial (reportes)
    tarjeta.querySelector('button').addEventListener('click', () => {
        if (activo) { abrirPanelEdicion(); } else { cargarVista('reportes'); }
    });
    return tarjeta;
}


/* ==========================================
   7. INICIO: Agenda del día + Recordatorios
   ========================================== */

function cargarAgendaInicio() {
    // La agenda devuelve un OBJETO (no un arreglo): { claseActual, proximas: [] }
    cargarAgendaObjeto();
    cargarRecordatorios();
    poblarSelectorCicloInicio();
}

/**
 * Llena el selector de "Ciclo Escolar Activo" con los datos reales del servidor.
 * Solo muestra los ciclos activos (activo: true); si no hay ninguno, avisa en el selector.
 */
async function poblarSelectorCicloInicio() {
    const selector = document.getElementById('selector-ciclo-inicio');
    if (!selector) return;

    try {
        const respuesta = await fetch(URL_API_CICLOS);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const ciclos = await respuesta.json();

        const activos = (Array.isArray(ciclos) ? ciclos : []).filter(c => c.activo);
        if (activos.length > 0) {
            selector.innerHTML = '<option disabled selected>Ciclo activo...</option>' +
                activos.map(c => `<option>${c.nombre}</option>`).join('');
            selector.value = activos[0].nombre; // El ciclo vigente queda seleccionado por defecto
        } else {
            selector.innerHTML = '<option disabled selected>Sin ciclo activo</option>';
        }
    } catch (error) {
        console.error('Error al cargar los ciclos del selector de inicio:', error);
        selector.innerHTML = '<option disabled selected>Error de conexión</option>';
    }
}

async function cargarAgendaObjeto() {
    const contClase = document.getElementById('contenedor-clase-actual');
    const contProximas = document.getElementById('contenedor-proximas-clases');
    if (!contClase || !contProximas) return;

    mostrarCargando(contClase);
    mostrarCargando(contProximas);

    try {
        const respuesta = await fetch(URL_API_AGENDA);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const agenda = await respuesta.json();

        // Clase en curso: el backend puede enviar null si no hay clase ahora
        if (agenda.claseActual) {
            contClase.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <span style="color:#15803D; font-size:13px; font-weight:bold; margin-bottom:8px; display:block; text-transform:uppercase;">🟢 Clase en Curso Ahora</span>
                        <h2 style="margin:5px 0; color:#166534; font-size:26px;">${agenda.claseActual.materia}</h2>
                        <p style="margin:0; color:#15803D; font-weight:500;">Grupo: ${agenda.claseActual.grupo}</p>
                    </div>
                    <div style="text-align:right; background:white; padding:10px 15px; border-radius:8px; border:1px solid #BBF7D0;">
                        <span style="display:block; font-size:16px; font-weight:bold; color:#166534;">🕒 ${agenda.claseActual.horario}</span>
                        <span style="display:block; font-size:13px; color:#15803D; margin-top:5px;">📍 ${agenda.claseActual.aula}</span>
                    </div>
                </div>
                <button style="width:100%; margin-top:20px; background:var(--verde-bandera); color:white; border:none; padding:12px; border-radius:8px; font-weight:bold; cursor:pointer; font-size:15px; transition:0.2s;" onclick="cargarVista('diario')">Pasar Lista a este Grupo ➔</button>`;
        } else {
            mostrarEstadoVacio(contClase, 'No hay ninguna clase en curso', 'La próxima clase aparecerá aquí conforme a tu horario.');
        }

        // Próximas clases: si "proximas" llega vacío, se muestra el estado amigable
        if (Array.isArray(agenda.proximas) && agenda.proximas.length > 0) {
            contProximas.innerHTML = agenda.proximas.map(clase => `
                <div style="background:var(--fondo-tarjeta); border-radius:12px; padding:20px; border-left:6px solid var(--guinda); box-shadow:0 2px 5px rgba(0,0,0,0.05); animation:fadeIn 0.4s;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <span style="color:var(--texto-secundario); font-size:13px; font-weight:bold; margin-bottom:8px; display:block; text-transform:uppercase;">⏭️ Siguiente Clase</span>
                            <h2 style="margin:5px 0; color:var(--texto-principal); font-size:20px;">${clase.materia}</h2>
                            <p style="margin:0; color:var(--texto-secundario); font-weight:500;">Grupo: ${clase.grupo}</p>
                        </div>
                        <div style="text-align:right; background:var(--fondo-app); padding:10px 15px; border-radius:8px; border:1px solid var(--borde);">
                            <span style="display:block; font-size:14px; font-weight:bold; color:var(--texto-principal);">🕒 ${clase.horario}</span>
                            <span style="display:block; font-size:13px; color:var(--texto-secundario); margin-top:5px;">📍 ${clase.aula}</span>
                        </div>
                    </div>
                </div>`).join('');
        } else {
            mostrarEstadoVacio(contProximas, 'No hay clases pendientes hoy', 'Disfruta tu descanso o revisa tus reportes históricos.');
        }
    } catch (error) {
        console.error('Error al cargar la agenda:', error);
        mostrarEstadoError(contClase);
        mostrarEstadoError(contProximas);
    }
}

async function cargarRecordatorios() {
    const contenedor = document.getElementById('contenedor-recordatorios');
    if (!contenedor) return;

    mostrarCargando(contenedor);

    try {
        const respuesta = await fetch(URL_API_RECORDATORIOS);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const notas = await respuesta.json();

        if (Array.isArray(notas) && notas.length > 0) {
            // Cada recordatorio pinta su barra lateral en dorado (prioridad) o neutra
            contenedor.innerHTML = notas.map(n => `
                <li style="padding:12px; background:${n.urgente ? '#fdfaf6' : 'var(--fondo-app)'}; border-radius:6px; margin-bottom:10px; border-left:3px solid ${n.urgente ? 'var(--dorado)' : 'var(--borde)'}; animation:fadeIn 0.4s;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                        <strong style="color:${n.urgente ? 'var(--dorado)' : 'var(--texto-secundario)'}; font-size:11px; text-transform:uppercase;">📚 ${n.grupo}</strong>
                        ${n.urgente ? '<span style="color:var(--dorado-claro); font-size:11px; font-weight:bold;">Urgente</span>' : ''}
                    </div>
                    ${n.texto}
                </li>`).join('');
        } else {
            mostrarEstadoVacio(contenedor, 'Sin notas ni recordatorios', 'Las notas que agregues en cada grupo se listarán aquí.');
        }
    } catch (error) {
        console.error('Error al cargar recordatorios:', error);
        mostrarEstadoError(contenedor);
    }
}


/* ==========================================
   8. DASHBOARD DE GRUPO (Navegación interna SPA)
   ==========================================
   Recibe el OBJETO grupo (datos reales del JSON) y adapta título,
   subtítulo y filtros según el modelo educativo. Si el parámetro llega
   como texto (llamadas antiguas), lo envuelve en un objeto básico. */
async function abrirDashboardGrupo(grupo) {
    try {
        // Normalización: acepta tanto objeto como llamada con texto plano
        if (typeof grupo === 'string') grupo = { nombre: arguments[0], textoMateria: arguments[1] };
        _grupoActivo = grupo; // Se guarda el contexto real para el dashboard y el Control Diario
        const nombre = grupo.nombre || 'Grupo';
        const textoMateria = grupo.textoMateria || (grupo.modelo === 'PRIMARIA' ? 'Múltiples Materias' : '');

        await cargarVista('dashboard-grupo'); // La vista interna también viaja por el motor SPA

        // 1. Textos del encabezado con los datos REALES del grupo
        const titulo = document.getElementById('titulo-dashboard-grupo');
        const subtitulo = document.getElementById('subtitulo-dashboard-grupo');
        if (titulo)  titulo.innerText = 'Dashboard: ' + nombre;
        if (subtitulo) subtitulo.innerText = grupo.modelo === 'PRIMARIA' ? 'Múltiples Materias (Modelo Primaria)' : textoMateria;

        // 2. Condicional de adaptabilidad: en Secundaria el reporte es directo,
        //    por lo que se oculta el "Paso 1: materia" del modal de reportes.
        const filtroMateria = document.getElementById('filtro-materia-primaria');
        if (filtroMateria) filtroMateria.style.display = grupo.modelo === 'PRIMARIA' ? 'block' : 'none';

    } catch (error) {
        console.error("Error al abrir el dashboard del grupo:", error);
    }
}


/* ==========================================
   9. CONTROL DIARIO: Alumnos desde el servidor
   ==========================================
   Cada fila se construye con los datos del JSON y se conecta a las
   mismas funciones interactivas que ya existían para el mock. */
function cargarAlumnosDiario() {
    cargarDatosJSON(URL_API_ALUMNOS, 'cuerpo-tabla-diario', renderizarFilasDiario,
        'Este grupo no tiene alumnos inscritos', 'Inscribe alumnos desde el dashboard del grupo.');
}

/**
 * Prepara el Control Diario: fija el contexto del grupo activo (si viene de un
 * dashboard) y lanza la carga de los alumnos reales para pintar las filas.
 */
function prepararControlDiario() {
    // El mallado transaccional se alimenta del servidor para el grupo activo
    if (_grupoActivo) {
        const titulo = document.getElementById('titulo-diario');
        const etiqueta = document.getElementById('etiqueta-materia-diario');
        if (titulo) titulo.innerText = '✅ Control Diario: ' + _grupoActivo.nombre;
        if (etiqueta && _grupoActivo.modelo === 'SECUNDARIA' && _grupoActivo.materias && _grupoActivo.materias.length > 0) {
            etiqueta.innerText = '📚 Materia: ' + _grupoActivo.materias[0].nombre;
        }
        cargarAlumnosDiario();
    } else if (document.getElementById('cuerpo-tabla-diario')) {
        // Sin grupo de contexto, el usuario debe elegir grupo desde el dashboard
        mostrarEstadoVacio(document.getElementById('cuerpo-tabla-diario'),
            'Sin grupo seleccionado', 'Abre un grupo en "Mis Grupos" para pasar lista.');
    }
}

function renderizarFilasDiario(listaAlumnos) {
    const tbody = document.getElementById('cuerpo-tabla-diario');
    if (!tbody) return;
    tbody.innerHTML = ''; // El contenedor se limpia (aquí previamente vivían filas falsas)

    listaAlumnos.forEach(alumno => {
        const fila = document.createElement('tr');
        fila.id = `fila-${alumno.id}`;
        fila.style = 'border-bottom: 1px solid var(--borde); transition: background 0.2s;';
        fila.innerHTML = `
            <td style="padding:15px; color:var(--texto-secundario); font-weight:bold;">${alumno.numero || alumno.id} | ${alumno.matricula}</td>
            <td style="font-weight:500; color:var(--texto-principal);">${alumno.nombre}</td>
            <td class="col-asistencia" style="text-align:center;">
                <input type="checkbox" class="check-asis" data-id="${alumno.id}" checked onchange="procesarClic(this)" style="width:22px; height:22px; cursor:pointer; accent-color:var(--verde-bandera);">
            </td>
            <td class="col-tarea" style="text-align:center;">
                <input type="checkbox" class="check-criterio" data-id="${alumno.id}" onchange="calcularDesempeno(${alumno.id})" style="width:22px; height:22px; cursor:pointer; accent-color:var(--verde-bandera);">
            </td>
            <td class="col-participacion" style="text-align:center;">
                <input type="checkbox" class="check-criterio" data-id="${alumno.id}" onchange="calcularDesempeno(${alumno.id})" style="width:22px; height:22px; cursor:pointer; accent-color:var(--verde-bandera);">
            </td>
            <td style="text-align:center;">
                <span id="badge-${alumno.id}" style="padding:6px 12px; border-radius:20px; font-weight:bold; font-size:13px; background:#FEF3C7; color:#92400E; display:inline-block; min-width:45px;">--</span>
            </td>
        `;
        tbody.appendChild(fila);
    });
}


/* ==========================================
   9a. DASHBOARD DE GRUPO: Carga de su contenido
   ==========================================
   El backend devuelve un objeto con el resumen del grupo:
   { promedio, horario: [], topCalificaciones: [], topAsistencia: [], notas: [], archivos: [] }
   Cada bloque repite el patrón: loader -> datos | vacío | error. */
async function cargarContenidoDashboardGrupo() {
    const contHorario = document.getElementById('cuadricula-horario');
    const contTopCal = document.getElementById('lista-top-calificaciones');
    const contTopAsis = document.getElementById('lista-top-asistencia');
    const contNotas = document.getElementById('lista-notas-grupo');
    const contArchivos = document.getElementById('lista-archivos-grupo');
    if (!contHorario) return;

    // Loaders simultáneos en los cuatro contenedores mientras responde el servidor
    mostrarCargando(contHorario); mostrarCargando(contTopCal);
    mostrarCargando(contTopAsis); mostrarCargando(contNotas); mostrarCargando(contArchivos);

    try {
        const respuesta = await fetch(URL_API_DASHBOARD);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const resumen = await respuesta.json();

        // Promedio general del grupo (dorado por valor ausente "--")
        const promedio = document.getElementById('promedio-general-grupo');
        promedio.innerText = resumen.promedio != null ? resumen.promedio : '--';

        // Horario semanal: estructura de 5 días generada desde el JSON
        if (resumen.horario && resumen.horario.length > 0) {
            contHorario.innerHTML = resumen.horario.map(bloque => `
                <div style="background: var(--fondo-app); border-radius: 8px; padding: 10px 5px; min-height: 100px;">
                    <div style="font-size: 12px; font-weight: bold; color: var(--texto-secundario); margin-bottom: 10px;">${bloque.dia}</div>
                    ${bloque.materia ? `<div style="background: #FCE7F3; color: #9D174D; font-size: 11px; padding: 6px; border-radius: 6px; font-weight: bold; border: 1px solid #FBCFE8;">${bloque.hora}<br><span style="font-size: 12px;">📚 ${bloque.materia}</span></div>` : ''}
                </div>`).join('');
        } else {
            mostrarEstadoVacio(contHorario, 'Sin horario asignado', 'Agrega bloques de clase a este grupo para verlos aquí.');
        }

        // Rankings (calificaciones y asistencia) con estados vacíos independientes
        if (resumen.topCalificaciones && resumen.topCalificaciones.length > 0) {
            contTopCal.innerHTML = resumen.topCalificaciones.map((a, i) => `
                <li style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--borde); font-size:14px; animation: fadeIn 0.4s;">
                    <span>${i + 1}. ${a.nombre}</span> <strong style="color: var(--verde-bandera);">${a.valor}</strong>
                </li>`).join('');
        } else {
            mostrarEstadoVacio(contTopCal, 'Sin calificaciones aún', 'Registra evaluaciones para generar el ranking.');
        }

        if (resumen.topAsistencia && resumen.topAsistencia.length > 0) {
            contTopAsis.innerHTML = resumen.topAsistencia.map((a, i) => `
                <li style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--borde); font-size:14px; animation: fadeIn 0.4s;">
                    <span>${i + 1}. ${a.nombre}</span> <strong style="color: var(--dorado);">${a.valor}</strong>
                </li>`).join('');
        } else {
            mostrarEstadoVacio(contTopAsis, 'Sin registros de asistencia', 'Pasa lista en el Control Diario para generar el ranking.');
        }

        // Notas del grupo
        if (resumen.notas && resumen.notas.length > 0) {
            contNotas.innerHTML = resumen.notas.map(n => `
                <li style="padding:12px; background:#fdfaf6; border-radius:6px; margin-bottom:8px; border-left:3px solid var(--dorado); animation: fadeIn 0.4s;">${n.texto}</li>`).join('');
        } else {
            mostrarEstadoVacio(contNotas, 'Sin notas en este grupo', 'Usa el botón "+ Nuevo" para registrar la primera.');
        }

        // Bóveda de materiales
        if (resumen.archivos && resumen.archivos.length > 0) {
            contArchivos.innerHTML = resumen.archivos.map(a => `
                <div style="background: white; padding: 12px; border-radius: 6px; border: 1px solid var(--borde); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border-left: 3px solid var(--verde-bandera); animation: fadeIn 0.4s;">
                    <span style="font-size: 13px; font-weight: 500; color: var(--texto-principal);">📄 ${a.nombre}</span>
                    <span style="cursor: pointer;" title="Abrir archivo">↗️</span>
                </div>`).join('');
        } else {
            mostrarEstadoVacio(contArchivos, 'Bóveda vacía', 'Adjunta material de clase con el botón de abajo.');
        }

    } catch (error) {
        console.error('Error al cargar el dashboard del grupo:', error);
        [contHorario, contTopCal, contTopAsis, contNotas, contArchivos].forEach(mostrarEstadoError);
    }
}


/* ==========================================
   9b. HISTORIAL DE REPORTES: búsqueda asíncrona
   ==========================================
   El embudo (ciclo -> escuela -> grupo) activa este fetch; la sábana se pinta
   solo si el servidor trae filas, de lo contrario se muestra el estado vacío. */
async function buscarHistorial() {
    const titulo = document.getElementById('titulo-resultados-historial');
    const promedio = document.getElementById('promedio-general-historial');
    const tbody = document.getElementById('cuerpo-tabla-historial');

    mostrarCargando(tbody);

    try {
        const respuesta = await fetch(URL_API_HISTORIAL);
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const historial = await respuesta.json();

        // Etiqueta con los filtros reales elegidos en el embudo
        if (titulo) {
            const ciclo = document.getElementById('filtro-hist-ciclo').value;
            titulo.innerText = `Resultados: ${ciclo || 'Ciclo no indicado'}`;
        }

        if (historial.alumnos && historial.alumnos.length > 0) {
            promedio.innerText = historial.promedio != null ? historial.promedio : '--';
            tbody.innerHTML = historial.alumnos.map(a => `
                <tr style="border-bottom: 1px solid var(--borde);">
                    <td style="padding:15px; color:var(--texto-secundario); font-weight:bold;">${a.matricula}</td>
                    <td style="color:var(--texto-principal);">${a.nombre}</td>
                    <td style="text-align:center; font-weight:bold; color:var(--texto-principal);">${a.promedio}</td>
                    <td style="text-align:center;"><span style="background:${a.aprobado ? '#D1FAE5' : '#FEE2E2'}; color:${a.aprobado ? '#065F46' : '#991B1B'}; padding:4px 10px; border-radius:20px; font-size:12px; font-weight:bold;">${a.aprobado ? 'Aprobado' : 'Reprobado'}</span></td>
                </tr>`).join('');
        } else {
            promedio.innerText = '--';
            mostrarEstadoVacio(tbody.parentElement, 'Sin registros en ese momento', 'Este ciclo no conserva calificaciones para esa selección.');
        }
    } catch (error) {
        console.error('Error al cargar el historial:', error);
        mostrarEstadoError(tbody.parentElement);
    }
}


/* ==========================================
   10. LÓGICA DEL MOTOR: CONTROL DIARIO
   ========================================== */

/**
 * Criterios Dinámicos: Oculta o muestra columnas enteras si el maestro desmarca el toggle superior.
 */
function alternarColumna(claseColumna, mostrar) {
    document.querySelectorAll('.' + claseColumna).forEach(elemento => {
        elemento.style.display = mostrar ? '' : 'none';
    });

    // Forzar recalculo de todos los alumnos basados en los nuevos criterios activos
    document.querySelectorAll('.check-asis').forEach(chk => {
        calcularDesempeno(chk.getAttribute('data-id'));
    });
}

/**
 * Lógica de Bloqueo: Si el alumno falta, bloquea y apaga tarea/participación.
 */
function procesarClic(checkboxAsistencia) {
    const idAlumno = checkboxAsistencia.getAttribute('data-id');
    const fila = document.getElementById(`fila-${idAlumno}`);
    const otrosCheckboxes = fila.querySelectorAll('.check-criterio');

    if (!checkboxAsistencia.checked) {
        // Alumno faltó: Pintar fila de rojo tenue y deshabilitar/limpiar casillas
        fila.style.background = '#FEF2F2';
        otrosCheckboxes.forEach(chk => {
            chk.checked = false;
            chk.disabled = true;
            chk.style.opacity = '0.3';
            chk.title = "Falta - No aplica";
        });
    } else {
        // Alumno asistió: Restaurar la fila
        fila.style.background = '';
        otrosCheckboxes.forEach(chk => {
            chk.disabled = false;
            chk.style.opacity = '1';
            chk.title = "";
        });
    }

    // Calcular su porcentaje final después del clic
    calcularDesempeno(idAlumno);
}

/**
 * Cálculo Automatizado al Instante.
 */
function calcularDesempeno(idAlumno) {
    const fila = document.getElementById(`fila-${idAlumno}`);
    const evalTarea = document.getElementById('toggle-tarea').checked;
    const evalParticipacion = document.getElementById('toggle-participacion').checked;

    let puntaje = 0;
    let criteriosActivos = 1; // Asistencia siempre vale 1 punto base

    // Si faltó, el puntaje es 0 automático
    const asistio = fila.querySelector('.check-asis').checked;
    if (!asistio) {
        actualizarBadge(idAlumno, 0);
        return;
    }

    puntaje++; // Suma el punto de asistencia

    // Evaluar si las columnas están activadas para sumar al total posible
    if (evalTarea) {
        criteriosActivos++;
        if (fila.querySelector('.col-tarea .check-criterio').checked) puntaje++;
    }
    if (evalParticipacion) {
        criteriosActivos++;
        if (fila.querySelector('.col-participacion .check-criterio').checked) puntaje++;
    }

    // Regla de tres simple para sacar el porcentaje del día
    let porcentaje = Math.round((puntaje / criteriosActivos) * 100);
    actualizarBadge(idAlumno, porcentaje);
}

/**
 * Actualiza el color de la etiqueta (Badge) dependiendo la calificación
 */
function actualizarBadge(idAlumno, porcentaje) {
    const badge = document.getElementById(`badge-${idAlumno}`);
    badge.innerText = porcentaje + '%';

    if (porcentaje >= 80) {
        badge.style.background = '#D1FAE5'; badge.style.color = '#065F46'; // Verde
    } else if (porcentaje >= 50) {
        badge.style.background = '#FEF3C7'; badge.style.color = '#92400E'; // Amarillo
    } else {
        badge.style.background = '#FEE2E2'; badge.style.color = '#991B1B'; // Rojo
    }
}

/**
 * Guardado asíncrono del Control Diario (Cero bloqueos en Electron).
 * TODO: reemplazar el setTimeout por el fetch() de envío al backend Java
 * usando la ruta POST correspondiente, conservando el feedback visual.
 * Sugerencia: reutilizar el fetch de cargarAlumnosDiario para reenviar
 * la serie de casillas marcadas por alumno.
 */
function guardarControlDiario() {
    const btn = document.getElementById('btn-guardar-diario');
    const textoOriginal = btn.innerText;

    btn.innerText = "¡Guardado con éxito! ✔";
    btn.style.background = "#065F46"; // Verde más oscuro

    // Regresar al estado normal después de 2 segundos sin trabar el sistema
    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.style.background = "var(--verde-bandera)";
    }, 2000);
}


/* ==========================================
   11. LÓGICA DE MODALES: CICLOS ESCOLARES
   ========================================== */

function abrirPanelEdicion() {
    document.getElementById('modal-editar-ciclo').style.display = 'flex';
}

function mostrarConfirmacionCierre() {
    // Oculta el primer modal y muestra la advertencia roja
    document.getElementById('modal-editar-ciclo').style.display = 'none';
    document.getElementById('modal-confirmacion-cierre').style.display = 'flex';
}

function volverAEdicion() {
    // Si se arrepiente, regresa al panel de edición
    document.getElementById('modal-confirmacion-cierre').style.display = 'none';
    document.getElementById('modal-editar-ciclo').style.display = 'flex';
}

function cerrarModalesCiclo() {
    // Cierra todo
    const modalEditar = document.getElementById('modal-editar-ciclo');
    const modalConfirmacion = document.getElementById('modal-confirmacion-cierre');
    if(modalEditar) modalEditar.style.display = 'none';
    if(modalConfirmacion) modalConfirmacion.style.display = 'none';
}


/* ==========================================
   12. LÓGICA DE CREACIÓN DE GRUPO (Híbrido)
   ========================================== */

function abrirModalCrearGrupo() {
    document.getElementById('modal-crear-grupo').style.display = 'flex';
}

function cerrarModalCrearGrupo() {
    document.getElementById('modal-crear-grupo').style.display = 'none';
}

/**
 * Alterna los contenedores visuales dependiendo si el maestro elige Primaria o Secundaria.
 */
function cambiarModeloGrupo(modelo) {
    const contSecundaria = document.getElementById('contenedor-secundaria');
    const contPrimaria = document.getElementById('contenedor-primaria');

    if (modelo === 'secundaria') {
        contSecundaria.style.display = 'block';
        contPrimaria.style.display = 'none';
    } else {
        contSecundaria.style.display = 'none';
        contPrimaria.style.display = 'block';
    }
}

/**
 * Añade una nueva fila de inputs para una materia adicional en el modelo Primaria.
 */
function agregarFilaMateria() {
    const listaMaterias = document.getElementById('lista-materias-primaria');

    const nuevaFila = document.createElement('div');
    nuevaFila.className = 'fila-materia';
    nuevaFila.style = 'display: grid; grid-template-columns: 2fr 1fr auto; gap: 10px; align-items: center; margin-top: 5px;';

    nuevaFila.innerHTML = `
        <input type="text" placeholder="Nombre (Ej. Ciencias)" style="padding: 10px; border: 1px solid var(--borde); border-radius: 6px;">
        <input type="text" placeholder="Horario" style="padding: 10px; border: 1px solid var(--borde); border-radius: 6px;">
        <button onclick="eliminarFilaMateria(this)" style="background: transparent; border: none; color: #DC2626; cursor: pointer; font-size: 16px; transition: 0.2s;" title="Eliminar materia">🗑️</button>
    `;

    listaMaterias.appendChild(nuevaFila);
}

/**
 * Elimina una fila específica de materia en el modelo Primaria.
 */
function eliminarFilaMateria(botonEliminar) {
    const fila = botonEliminar.closest('.fila-materia');
    fila.remove();
}

/**
 * Guardado asíncrono del nuevo grupo (Cero Bloqueos).
 * TODO: conectar con el POST de URL_API_GRUPOS hacia el backend Java
 * y después recargar la lista con cargarGrupos().
 */
function simularGuardadoGrupo() {
    const btn = document.getElementById('btn-guardar-nuevo-grupo');
    const textoOriginal = btn.innerText;

    btn.innerText = "¡Grupo Creado! ✔";
    btn.style.background = "var(--verde-bandera)";

    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.style.background = "var(--guinda)";
        cerrarModalCrearGrupo();
        cargarGrupos(); // Repuebla la cuadrícula con los datos actualizados del servidor
    }, 1500);
}


/* ==========================================
   13. LÓGICA DEL DASHBOARD DE GRUPO (Acciones)
   ========================================== */

/**
 * Función genérica de Cero Bloqueos para dar feedback visual a los botones.
 */
function simularExito(idBoton, textoExito, colorExito, colorOriginal) {
    const btn = document.getElementById(idBoton);
    const textoOriginal = btn.innerText;

    btn.innerText = textoExito;
    btn.style.background = colorExito;

    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.style.background = colorOriginal;
    }, 2000);
}

/**
 * Guarda los Criterios y cierra el modal automáticamente
 */
function guardarCriterios() {
    simularExito('btn-guardar-criterios', '¡Guardado! ✔', 'var(--verde-bandera)', 'var(--guinda)');
    setTimeout(() => {
        document.getElementById('modal-criterios').style.display = 'none';
    }, 1000); // Cierra el modal 1 segundo después del mensaje de éxito
}

/**
 * Lee el texto del modal de Notas, crea un nuevo elemento HTML y lo inyecta en la lista.
 */
function agregarNotaGrupo() {
    const textarea = document.getElementById('texto-nueva-nota');
    const texto = textarea.value.trim();

    if (texto === "") return; // No guarda notas vacías

    const lista = document.getElementById('lista-notas-grupo');

    // Crear el nuevo elemento (li)
    const nuevaNota = document.createElement('li');
    nuevaNota.style = 'padding: 12px; background: #fdfaf6; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid var(--dorado); animation: fadeIn 0.5s;';
    nuevaNota.innerText = texto;

    // Inyectarlo al principio de la lista
    lista.prepend(nuevaNota);

    // Limpiar input y dar feedback
    textarea.value = "";
    simularExito('btn-guardar-nota', '¡Agregada!', 'var(--verde-bandera)', 'var(--dorado)');
    setTimeout(() => { document.getElementById('modal-nueva-nota').style.display = 'none'; }, 800);
}

/**
 * Lee el nombre del archivo seleccionado y lo agrega al repositorio visual.
 */
function procesarArchivoAdjunto(input) {
    if (input.files && input.files[0]) {
        const nombreArchivo = input.files[0].name;
        const listaArchivos = document.getElementById('lista-archivos-grupo');

        // Crear el contenedor del nuevo archivo
        const nuevoArchivo = document.createElement('div');
        nuevoArchivo.style = 'background: white; padding: 12px; border-radius: 6px; border: 1px solid var(--borde); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border-left: 3px solid var(--verde-bandera); animation: fadeIn 0.4s;';

        nuevoArchivo.innerHTML = `
            <span style="font-size: 13px; font-weight: 500; color: var(--texto-principal);">📄 ${nombreArchivo}</span>
            <span style="cursor: pointer;" title="Abrir archivo">↗️</span>
        `;

        // Inyectar a la lista
        listaArchivos.appendChild(nuevoArchivo);

        // Feedback visual en el botón principal
        simularExito('btn-adjuntar', '¡Archivo Subido! ✔', 'var(--verde-bandera)', 'white');
        document.getElementById('btn-adjuntar').style.color = "white"; // Ajuste de texto temporal
        setTimeout(() => { document.getElementById('btn-adjuntar').style.color = "var(--guinda)"; }, 2000);

        // Limpiar el input para permitir subir el mismo archivo si es necesario
        input.value = '';
    }
}


/**
 * Añade un nuevo periodo dinámicamente al selector del Modal de Criterios
 */
function guardarNuevoPeriodo() {
    const input = document.getElementById('input-nuevo-periodo');
    const selector = document.getElementById('selector-periodo');
    const nombrePeriodo = input.value.trim();

    if (nombrePeriodo !== "") {
        // Crear la nueva opción
        const nuevaOpcion = document.createElement('option');
        nuevaOpcion.text = nombrePeriodo;
        nuevaOpcion.value = nombrePeriodo;

        // Añadirla al selector y seleccionarla por defecto
        selector.add(nuevaOpcion);
        selector.value = nombrePeriodo;

        // Limpiar y ocultar el input
        input.value = "";
        document.getElementById('caja-nuevo-periodo').style.display = 'none';
    }
}

/**
 * Guardado asíncrono para la nueva Escuela (Cero Bloqueos).
 * TODO: conectar con el POST de URL_API_ESCUELAS y recargar con cargarEscuelas().
 */
function simularGuardadoEscuela() {
    const btn = document.getElementById('btn-guardar-escuela');
    const textoOriginal = btn.innerText;

    btn.innerText = "¡Escuela Registrada! ✔";
    btn.style.background = "var(--verde-bandera)";

    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.style.background = "var(--guinda)";
        document.getElementById('modal-crear-escuela').style.display = 'none';
        cargarEscuelas(); // Refresca el directorio con los datos real del servidor
    }, 1500);
}


/**
 * Abre el modal de escuelas y rellena los datos para edición.
 */
function abrirModalEditarEscuela(nombre, cct, ubicacion) {
    // Rellenar campos
    const inputNombre = document.getElementById('input-escuela-nombre');
    const inputCct = document.getElementById('input-escuela-cct');
    const inputUbicacion = document.getElementById('input-escuela-ubicacion');

    if(inputNombre) inputNombre.value = nombre;
    if(inputCct) inputCct.value = cct;
    if(inputUbicacion) inputUbicacion.value = ubicacion;

    // Cambiar textos para reflejar "Edición"
    document.getElementById('titulo-modal-escuela').innerText = '✏️ Editar Institución';
    const btn = document.getElementById('btn-guardar-escuela');
    if(btn) btn.innerText = '💾 Guardar Cambios';

    // Mostrar el modal
    document.getElementById('modal-crear-escuela').style.display = 'flex';
}

/**
 * Guardado asíncrono del nuevo ciclo escolar (Cero Bloqueos).
 * TODO: conectar con el POST de URL_API_CICLOS y recargar con cargarCiclos().
 */
function simularExitoCiclo() {
    const btn = document.getElementById('btn-guardar-nuevo-ciclo');
    const textoOriginal = btn.innerText;

    btn.innerText = "¡Ciclo Creado! ✔";
    btn.style.background = "var(--verde-bandera)";

    setTimeout(() => {
        btn.innerText = textoOriginal;
        btn.style.background = "var(--guinda)";
        document.getElementById('modal-agregar-ciclo').style.display = 'none';
        cargarCiclos(); // Refresca el directorio de ciclos con los datos reales
    }, 1500);
}


/* ==========================================
   14. LÓGICA DEL HISTORIAL DE REPORTES (EMBUDO)
   ========================================== */

/**
 * Desbloquea el siguiente select en el embudo.
 */
function activarFiltroHistorial(idSiguiente) {
    const selectSiguiente = document.getElementById(idSiguiente);
    if (selectSiguiente) {
        selectSiguiente.disabled = false;
        selectSiguiente.style.opacity = "1";
    }
}

/**
 * Activa el botón de búsqueda una vez que se completó el embudo.
 */
function activarBotonBusqueda() {
    const btn = document.getElementById('btn-buscar-historial');
    if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
    }
}

/**
 * Muestra la sábana de calificaciones histórica.
 * Ejecuta el fetch Asíncrono a la ruta de reportes históricos del backend Java
 * y pinta 'cuerpo-tabla-historial' con la respuesta (buscadorHistorial maneja
 * loading, resultado con datos, vacío y error).
 */
function mostrarResultadosHistorial() {
    const panel = document.getElementById('panel-resultados-historial');
    const btn = document.getElementById('btn-buscar-historial');

    // Cero Fricción: mostrar el panel y avisar carga en el botón
    panel.style.display = 'block';
    btn.innerText = "⏳ Cargando historial...";
    btn.style.opacity = "0.7";

    buscarHistorial().finally(() => {
        btn.innerText = "🔍 Resultados Cargados";
        btn.style.background = "var(--verde-bandera)";
        btn.style.opacity = "1";
    });
}

/**
 * Cero Fricción: Animación para la exportación de documentos cerrados.
 */
function simularExportacionHistorial(idBoton, textoOriginal, colorOriginal) {
    const btn = document.getElementById(idBoton);
    btn.innerText = "⏳ Exportando...";
    btn.style.opacity = "0.7";
    btn.style.pointerEvents = "none";

    setTimeout(() => {
        btn.innerText = "¡Archivo Guardado! ✔";
        btn.style.opacity = "1";
        btn.style.background = "var(--verde-bandera)";

        setTimeout(() => {
            btn.innerText = `Exportar ${textoOriginal}`;
            btn.style.background = colorOriginal;
            btn.style.pointerEvents = "auto";
        }, 2000);
    }, 1500);
}
