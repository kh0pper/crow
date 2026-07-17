/**
 * PM Workspace — drawing note editor.
 *
 * Ported from canvas-companion's whiteboard engine (Fabric.js 5.3.1 +
 * perfect-freehand): single full-screen canvas with pan/zoom, grid
 * background, pressure-sensitive drawing with palm rejection, text,
 * shapes, eraser, undo/redo.
 *
 * PM Workspace changes vs the original:
 *   - Saves the WHOLE note in one POST to PM_BASE + /api/pm/notes as a
 *     text/plain JSON string ({id, title, kind, strokes_json,
 *     image_data_url, tags}) — text/plain bypasses the gateway's 1mb
 *     JSON parser cap for large PNG data URLs.
 *   - On save it also exports a PNG snapshot (canvas.toDataURL) so the
 *     server can OCR the handwriting.
 *   - Tags are simple client-side chips submitted with each save.
 */
import { getStroke } from 'perfect-freehand';

// ── Section 1: State ───────────────────────────────────────────────────────

const GRID_SIZE = 25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const AUTOSAVE_DELAY = 1500;
const UNDO_LIMIT = 50;

const PM_BASE = window.PM_BASE || '';

const state = {
    noteId: null,
    title: '',
    tags: [],
    fabricCanvas: null,
    activeTool: 'pen',
    activeColor: '#000000',
    activeSize: 2,
    activeShape: 'rect',
    penDetected: false,
    penTimeout: null,
    penActivelyDrawing: false,
    isDrawing: false,
    currentStroke: null,
    shapeStart: null,
    previewShape: null,
    previewPath: null,
    _previewRafPending: false,
    isPanning: false,
    panStart: null,
    spaceHeld: false,
    touchPanning: false,
    lastTouchDist: null,
    lastTouchCenter: null,
    undoStack: [],
    redoStack: [],
    saveTimer: null,
    dirty: false,
    saving: false,
    exporting: false,
};


// ── Section 2: Initialization ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    if (!window.NOTE_DATA) return;
    state.noteId = window.NOTE_DATA.id || null;
    state.title = window.NOTE_DATA.title || '';
    state.tags = (window.NOTE_DATA.tags || []).slice();

    const titleInput = document.getElementById('note-title');
    if (titleInput) titleInput.value = state.title;
    renderTagChips();

    initCanvas();
    if (state.fabricCanvas) {
        loadWhiteboardContent(window.NOTE_DATA.strokes_json);
    }
    bindToolbar();
    bindTitleSave();
    bindKeyboardShortcuts();
    bindPageLifecycle();
    bindZoomIndicator();
    updateCursorStyle();
});


// ── Section 3: Canvas Init ─────────────────────────────────────────────────

function initCanvas() {
    const container = document.getElementById('whiteboard-area');
    const canvasEl = document.getElementById('whiteboard-canvas');
    if (!container || !canvasEl) return;

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        setTimeout(initCanvas, 100);
        return;
    }

    const fabricCanvas = new fabric.Canvas(canvasEl, {
        isDrawingMode: false,
        selection: false,
        width: rect.width,
        height: rect.height,
        backgroundColor: 'transparent',
        preserveObjectStacking: true,
        allowTouchScrolling: false,
    });

    state.fabricCanvas = fabricCanvas;

    fabricCanvas.on('after:render', () => { if (!state.exporting) drawGrid(fabricCanvas); });

    setupPointerEvents(fabricCanvas, container);
    setupTouchGestures(fabricCanvas, container);
    setupWheelZoom(fabricCanvas);

    let resizeTimer = null;
    let lastW = rect.width;
    let lastH = rect.height;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const r = container.getBoundingClientRect();
            if (Math.abs(r.width - lastW) > 2 || Math.abs(r.height - lastH) > 2) {
                lastW = r.width;
                lastH = r.height;
                fabricCanvas.setWidth(r.width);
                fabricCanvas.setHeight(r.height);
                fabricCanvas.renderAll();
            }
        }, 250);
    });

    fabricCanvas.renderAll();
}


function drawGrid(fabricCanvas) {
    const ctx = fabricCanvas.getContext();
    const vpt = fabricCanvas.viewportTransform;
    const zoom = fabricCanvas.getZoom();
    const panX = vpt[4];
    const panY = vpt[5];

    const w = fabricCanvas.getWidth();
    const h = fabricCanvas.getHeight();

    const gridSpacing = GRID_SIZE * zoom;
    if (gridSpacing < 8) return;

    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    ctx.strokeStyle = isDark ? '#333' : '#e0e0e0';
    ctx.lineWidth = 1;

    const offsetX = panX % gridSpacing;
    const offsetY = panY % gridSpacing;

    ctx.beginPath();
    for (let x = offsetX; x <= w; x += gridSpacing) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = offsetY; y <= h; y += gridSpacing) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
}


function loadWhiteboardContent(strokesJson) {
    if (!strokesJson || !state.fabricCanvas) {
        if (state.fabricCanvas) pushUndoState();
        return;
    }
    let content = {};
    try { content = JSON.parse(strokesJson) || {}; } catch (_) { content = {}; }

    const objects = content.objects || [];
    for (const obj of objects) {
        if (obj.type === 'stroke') {
            addStrokeToCanvas(state.fabricCanvas, obj);
        } else if (obj.type === 'text') {
            addTextToCanvas(state.fabricCanvas, obj);
        } else if (obj.type === 'shape') {
            loadShapeObject(state.fabricCanvas, obj);
        }
    }

    if (content.viewport) {
        const vp = content.viewport;
        const z = vp.zoom || 1;
        state.fabricCanvas.setViewportTransform([z, 0, 0, z, vp.x || 0, vp.y || 0]);
        updateZoomIndicator();
    }

    state.fabricCanvas.renderAll();
    pushUndoState();
}


function addTextToCanvas(fabricCanvas, obj) {
    const text = new fabric.IText(obj.text || '', {
        left: obj.left || 0,
        top: obj.top || 0,
        fontSize: obj.fontSize || 24,
        fill: obj.fill || '#000000',
        scaleX: obj.scaleX || 1,
        scaleY: obj.scaleY || 1,
        angle: obj.angle || 0,
        fontFamily: 'sans-serif',
        selectable: false,
        evented: false,
    });
    text._textData = { fontSize: obj.fontSize || 24, fill: obj.fill || '#000000' };
    fabricCanvas.add(text);
    return text;
}


function loadShapeObject(fabricCanvas, obj) {
    const shapeData = { ...obj };
    let shape = null;
    const shapeType = shapeData.shapeType || 'rect';
    const color = shapeData.color || '#000000';
    const strokeWidth = shapeData.strokeWidth || 2;

    if (shapeType === 'line') {
        shape = new fabric.Line(
            [shapeData.x1 || 0, shapeData.y1 || 0, shapeData.x2 || 0, shapeData.y2 || 0],
            { stroke: color, strokeWidth }
        );
    } else if (shapeType === 'rect') {
        shape = new fabric.Rect({
            width: shapeData.width || 0,
            height: shapeData.height || 0,
            fill: 'transparent',
            stroke: color,
            strokeWidth,
        });
    } else if (shapeType === 'circle') {
        shape = new fabric.Ellipse({
            rx: shapeData.rx || 0,
            ry: shapeData.ry || 0,
            fill: 'transparent',
            stroke: color,
            strokeWidth,
        });
    }

    if (shape) {
        shape.set({
            left: obj.left || 0,
            top: obj.top || 0,
            scaleX: obj.scaleX || 1,
            scaleY: obj.scaleY || 1,
            selectable: false,
            evented: false,
        });
        shape._shapeData = shapeData;
        fabricCanvas.add(shape);
    }
}


// ── Section 4: Pointer Events ──────────────────────────────────────────────

function setupPointerEvents(fabricCanvas, container) {
    const upper = fabricCanvas.upperCanvasEl;

    upper.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'pen') {
            state.penDetected = true;
            clearTimeout(state.penTimeout);
        }
    });
    upper.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'pen' && !state.penActivelyDrawing) {
            clearTimeout(state.penTimeout);
            state.penTimeout = setTimeout(() => { state.penDetected = false; }, 2000);
        }
    });

    upper.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'pen') {
            state.penDetected = true;
            state.penActivelyDrawing = true;
            clearTimeout(state.penTimeout);
        }
        if (e.pointerType === 'touch' && state.penDetected) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (state.touchPanning) return;

        if (e.button === 1) {
            e.preventDefault();
            startPan(e, container, upper);
            return;
        }

        if (state.spaceHeld && e.button === 0) {
            e.preventDefault();
            startPan(e, container, upper);
            return;
        }

        if (state.activeTool === 'select') {
            return;
        }

        if (state.activeTool === 'text') {
            e.preventDefault();
            const pt = canvasPoint(e, fabricCanvas);
            placeText(fabricCanvas, pt);
            return;
        }

        upper.setPointerCapture(e.pointerId);
        e.preventDefault();

        const point = canvasPoint(e, fabricCanvas);

        if (state.activeTool === 'eraser') {
            state.isDrawing = true;
            handleEraser(fabricCanvas, point);
            return;
        }

        if (state.activeTool === 'shape') {
            state.isDrawing = true;
            state.shapeStart = point;
            return;
        }

        state.currentStroke = {
            points: [[point.x, point.y, e.pressure || 0.5]],
            color: state.activeColor,
            size: state.activeSize,
            tool: state.activeTool,
            opacity: state.activeTool === 'highlighter' ? 0.4 : 1.0,
        };
        state.isDrawing = true;
    });

    upper.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' && state.penDetected) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (state.isPanning && state.panStart) {
            const dx = e.clientX - state.panStart.x;
            const dy = e.clientY - state.panStart.y;
            state.panStart = { x: e.clientX, y: e.clientY };
            const vpt = fabricCanvas.viewportTransform.slice();
            vpt[4] += dx;
            vpt[5] += dy;
            fabricCanvas.setViewportTransform(vpt);
            fabricCanvas.renderAll();
            e.preventDefault();
            return;
        }

        if (!state.isDrawing) return;

        e.preventDefault();
        const point = canvasPoint(e, fabricCanvas);

        if (state.activeTool === 'eraser') {
            handleEraser(fabricCanvas, point);
            return;
        }

        if (state.activeTool === 'shape') {
            drawShapePreview(fabricCanvas, state.shapeStart, point);
            return;
        }

        if (!state.currentStroke) return;

        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ce of events) {
            const cp = canvasPoint(ce, fabricCanvas);
            state.currentStroke.points.push([cp.x, cp.y, ce.pressure || 0.5]);
        }

        if (!state._previewRafPending) {
            state._previewRafPending = true;
            requestAnimationFrame(() => {
                state._previewRafPending = false;
                if (state.currentStroke) {
                    drawStrokePreview(fabricCanvas, state.currentStroke);
                }
            });
        }
    });

    upper.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'touch' && state.penDetected) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (state.isPanning) {
            endPan(container, upper, e);
            return;
        }

        if (!state.isDrawing) return;

        try { upper.releasePointerCapture(e.pointerId); } catch (_) { /* ok */ }

        if (e.pointerType === 'pen') {
            state.penActivelyDrawing = false;
            clearTimeout(state.penTimeout);
            state.penTimeout = setTimeout(() => { state.penDetected = false; }, 2000);
        }

        const point = canvasPoint(e, fabricCanvas);

        if (state.activeTool === 'eraser') {
            state.isDrawing = false;
            return;
        }

        if (state.activeTool === 'shape') {
            finalizeShape(fabricCanvas, state.shapeStart, point);
            state.isDrawing = false;
            state.shapeStart = null;
            return;
        }

        if (!state.currentStroke) {
            state.isDrawing = false;
            return;
        }

        state.currentStroke.points.push([point.x, point.y, e.pressure || 0.5]);

        if (state.previewPath) {
            fabricCanvas.remove(state.previewPath);
            state.previewPath = null;
        }

        finalizeStroke(fabricCanvas, state.currentStroke);
        state.currentStroke = null;
        state.isDrawing = false;
    });

    upper.addEventListener('lostpointercapture', () => {
        if (state.isPanning) {
            state.isPanning = false;
            state.panStart = null;
            container.classList.remove('panning');
        }
        if (state.isDrawing && state.currentStroke) {
            if (state.previewPath) {
                fabricCanvas.remove(state.previewPath);
                state.previewPath = null;
            }
            finalizeStroke(fabricCanvas, state.currentStroke);
            state.currentStroke = null;
            state.isDrawing = false;
        }
    });

    upper.addEventListener('contextmenu', (e) => e.preventDefault());
}


function startPan(e, container, upper) {
    state.isPanning = true;
    state.panStart = { x: e.clientX, y: e.clientY };
    container.classList.add('panning');
    upper.setPointerCapture(e.pointerId);
}


function endPan(container, upper, e) {
    state.isPanning = false;
    state.panStart = null;
    container.classList.remove('panning');
    try { upper.releasePointerCapture(e.pointerId); } catch (_) { /* ok */ }
}


function canvasPoint(e, fabricCanvas) {
    const upper = fabricCanvas.upperCanvasEl;
    const rect = upper.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const vpt = fabricCanvas.viewportTransform;
    const zoom = vpt[0];
    const panX = vpt[4];
    const panY = vpt[5];
    return {
        x: (screenX - panX) / zoom,
        y: (screenY - panY) / zoom,
    };
}


// ── Section 4b: Touch Gestures ─────────────────────────────────────────────

function setupTouchGestures(fabricCanvas, container) {
    const el = container;

    el.addEventListener('touchstart', (e) => {
        if (state.penDetected) {
            e.preventDefault();
            return;
        }
        if (e.touches.length === 2) {
            e.preventDefault();
            state.touchPanning = true;
            state.lastTouchDist = getTouchDist(e.touches);
            state.lastTouchCenter = getTouchCenter(e.touches);

            if (state.isDrawing) {
                if (state.previewPath) {
                    fabricCanvas.remove(state.previewPath);
                    state.previewPath = null;
                }
                if (state.previewShape) {
                    fabricCanvas.remove(state.previewShape);
                    state.previewShape = null;
                }
                state.currentStroke = null;
                state.isDrawing = false;
            }
        }
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
        if (state.penDetected) { e.preventDefault(); return; }
        if (e.touches.length === 2 && state.touchPanning) {
            e.preventDefault();
            const dist = getTouchDist(e.touches);
            const center = getTouchCenter(e.touches);

            if (state.lastTouchDist) {
                const scale = dist / state.lastTouchDist;
                const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fabricCanvas.getZoom() * scale));
                fabricCanvas.zoomToPoint(new fabric.Point(center.x, center.y), newZoom);
            }

            if (state.lastTouchCenter) {
                const dx = center.x - state.lastTouchCenter.x;
                const dy = center.y - state.lastTouchCenter.y;
                const vpt = fabricCanvas.viewportTransform.slice();
                vpt[4] += dx;
                vpt[5] += dy;
                fabricCanvas.setViewportTransform(vpt);
            }

            state.lastTouchDist = dist;
            state.lastTouchCenter = center;
            updateZoomIndicator();
            fabricCanvas.renderAll();
        }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            state.touchPanning = false;
            state.lastTouchDist = null;
            state.lastTouchCenter = null;
        }
    });
}


function setupWheelZoom(fabricCanvas) {
    fabricCanvas.on('mouse:wheel', (opt) => {
        const e = opt.e;
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        let zoom = fabricCanvas.getZoom();
        zoom *= 0.999 ** e.deltaY;
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
        fabricCanvas.zoomToPoint(new fabric.Point(e.offsetX, e.offsetY), zoom);
        updateZoomIndicator();
    });
}


function getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getTouchCenter(touches) {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
    };
}


// ── Section 5: Stroke Rendering ─────────────────────────────────────────────

function getStrokeOptions(tool, size) {
    const baseOptions = {
        size: size * 2,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
        easing: (t) => t,
        start: { taper: 0, cap: true },
        end: { taper: 0, cap: true },
    };
    if (tool === 'highlighter') {
        baseOptions.size = size * 6;
        baseOptions.thinning = 0;
    }
    return baseOptions;
}


function finalizeStroke(fabricCanvas, strokeData) {
    if (!strokeData || strokeData.points.length < 2) return;
    addStrokeToCanvas(fabricCanvas, strokeData);
    pushUndoState();
    markDirty();
}


function addStrokeToCanvas(fabricCanvas, strokeData) {
    const options = getStrokeOptions(strokeData.tool || 'pen', strokeData.size || 2);
    const outlinePoints = getStroke(strokeData.points, options);
    if (outlinePoints.length === 0) return;

    const pathData = pointsToSvgPath(outlinePoints);
    if (!pathData) return;

    const path = new fabric.Path(pathData, {
        fill: strokeData.color || '#000000',
        stroke: 'none',
        strokeWidth: 0,
        opacity: strokeData.opacity || 1.0,
        selectable: false,
        evented: false,
    });

    path._strokeData = strokeData;
    fabricCanvas.add(path);
    fabricCanvas.renderAll();
}


function drawStrokePreview(fabricCanvas, strokeData) {
    if (state.previewPath) {
        fabricCanvas.remove(state.previewPath);
        state.previewPath = null;
    }
    if (strokeData.points.length < 2) return;

    const options = getStrokeOptions(strokeData.tool, strokeData.size);
    const outlinePoints = getStroke(strokeData.points, options);
    if (outlinePoints.length === 0) return;

    const pathData = pointsToSvgPath(outlinePoints);
    if (!pathData) return;

    const path = new fabric.Path(pathData, {
        fill: strokeData.color,
        stroke: 'none',
        strokeWidth: 0,
        opacity: strokeData.opacity || 1.0,
        selectable: false,
        evented: false,
    });

    state.previewPath = path;
    fabricCanvas.add(path);
    fabricCanvas.renderAll();
}


function pointsToSvgPath(points) {
    if (points.length < 2) return null;

    let d = 'M ' + points[0][0].toFixed(2) + ' ' + points[0][1].toFixed(2);

    if (points.length === 2) {
        d += ' L ' + points[1][0].toFixed(2) + ' ' + points[1][1].toFixed(2);
        return d;
    }

    for (let i = 1; i < points.length - 1; i++) {
        const cp = points[i];
        const next = points[i + 1];
        const midX = ((cp[0] + next[0]) / 2).toFixed(2);
        const midY = ((cp[1] + next[1]) / 2).toFixed(2);
        d += ' Q ' + cp[0].toFixed(2) + ' ' + cp[1].toFixed(2) + ' ' + midX + ' ' + midY;
    }

    const last = points[points.length - 1];
    d += ' L ' + last[0].toFixed(2) + ' ' + last[1].toFixed(2);
    d += ' Z';
    return d;
}


// ── Section 6: Eraser ──────────────────────────────────────────────────────

function handleEraser(fabricCanvas, point) {
    const tolerance = 10;
    const objects = fabricCanvas.getObjects();
    const toRemove = [];

    for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        const bounds = obj.getBoundingRect(true);
        if (
            point.x < bounds.left - tolerance ||
            point.x > bounds.left + bounds.width + tolerance ||
            point.y < bounds.top - tolerance ||
            point.y > bounds.top + bounds.height + tolerance
        ) {
            continue;
        }
        toRemove.push(obj);
    }

    if (toRemove.length > 0) {
        toRemove.forEach(obj => fabricCanvas.remove(obj));
        fabricCanvas.renderAll();
        pushUndoState();
        markDirty();
    }
}


// ── Section 7: Shapes ──────────────────────────────────────────────────────

function drawShapePreview(fabricCanvas, start, current) {
    if (state.previewShape) {
        fabricCanvas.remove(state.previewShape);
        state.previewShape = null;
    }
    const shape = createShapeObject(start, current);
    if (shape) {
        state.previewShape = shape;
        fabricCanvas.add(shape);
        fabricCanvas.renderAll();
    }
}


function finalizeShape(fabricCanvas, start, end) {
    if (state.previewShape) {
        fabricCanvas.remove(state.previewShape);
        state.previewShape = null;
    }
    if (!start || !end) return;

    const shape = createShapeObject(start, end);
    if (shape) {
        shape.selectable = false;
        shape.evented = false;

        const shapeType = state.activeShape;
        if (shapeType === 'line') {
            shape._shapeData = {
                shapeType: 'line', x1: start.x, y1: start.y, x2: end.x, y2: end.y,
                color: state.activeColor, strokeWidth: state.activeSize,
            };
        } else if (shapeType === 'rect') {
            shape._shapeData = {
                shapeType: 'rect', width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
                color: state.activeColor, strokeWidth: state.activeSize,
            };
        } else if (shapeType === 'circle') {
            shape._shapeData = {
                shapeType: 'circle', rx: Math.abs(end.x - start.x) / 2, ry: Math.abs(end.y - start.y) / 2,
                color: state.activeColor, strokeWidth: state.activeSize,
            };
        }

        fabricCanvas.add(shape);
        fabricCanvas.renderAll();
        pushUndoState();
        markDirty();
    }
}


function createShapeObject(start, end) {
    const color = state.activeColor;
    const sw = state.activeSize;

    if (state.activeShape === 'line') {
        return new fabric.Line([start.x, start.y, end.x, end.y], {
            stroke: color, strokeWidth: sw, selectable: false, evented: false,
        });
    }
    if (state.activeShape === 'rect') {
        return new fabric.Rect({
            left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
            fill: 'transparent', stroke: color, strokeWidth: sw,
            selectable: false, evented: false,
        });
    }
    if (state.activeShape === 'circle') {
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        return new fabric.Ellipse({
            left: (start.x + end.x) / 2 - rx, top: (start.y + end.y) / 2 - ry,
            rx, ry, fill: 'transparent', stroke: color, strokeWidth: sw,
            selectable: false, evented: false,
        });
    }
    return null;
}


// ── Section 8: Text Tool ────────────────────────────────────────────────────

function placeText(fabricCanvas, point) {
    const text = new fabric.IText('', {
        left: point.x,
        top: point.y,
        fontSize: Math.max(16, state.activeSize * 6),
        fill: state.activeColor,
        fontFamily: 'sans-serif',
        selectable: true,
        evented: true,
    });
    text._textData = { fontSize: text.fontSize, fill: text.fill };
    fabricCanvas.add(text);
    fabricCanvas.setActiveObject(text);
    text.enterEditing();
    fabricCanvas.renderAll();

    text.on('editing:exited', () => {
        if (!text.text || text.text.trim() === '') {
            fabricCanvas.remove(text);
        } else {
            text.selectable = false;
            text.evented = false;
        }
        pushUndoState();
        markDirty();
    });
}


// ── Section 10: Undo/Redo ──────────────────────────────────────────────────

function pushUndoState() {
    if (!state.fabricCanvas) return;
    const json = JSON.stringify(serializeCanvas(state.fabricCanvas));
    if (state.undoStack.length > 0 && state.undoStack[state.undoStack.length - 1] === json) return;

    state.undoStack.push(json);
    state.redoStack = [];
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    updateUndoRedoButtons();
}


function undo() {
    if (state.undoStack.length <= 1) return;
    state.redoStack.push(state.undoStack.pop());
    restoreCanvasState(JSON.parse(state.undoStack[state.undoStack.length - 1]));
    updateUndoRedoButtons();
    markDirty();
}


function redo() {
    if (state.redoStack.length === 0) return;
    const next = state.redoStack.pop();
    state.undoStack.push(next);
    restoreCanvasState(JSON.parse(next));
    updateUndoRedoButtons();
    markDirty();
}


function restoreCanvasState(data) {
    const fc = state.fabricCanvas;
    fc.clear();
    for (const obj of (data.objects || [])) {
        if (obj.type === 'stroke') addStrokeToCanvas(fc, obj);
        else if (obj.type === 'text') addTextToCanvas(fc, obj);
        else if (obj.type === 'shape') loadShapeObject(fc, obj);
    }
    fc.renderAll();
}


function updateUndoRedoButtons() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = state.undoStack.length <= 1;
    if (r) r.disabled = state.redoStack.length === 0;
}


// ── Section 11: Serialization ──────────────────────────────────────────────

function serializeCanvas(fabricCanvas) {
    const objects = [];
    for (const obj of fabricCanvas.getObjects()) {
        if (obj._strokeData) {
            objects.push({ type: 'stroke', ...obj._strokeData });
        } else if (obj.type === 'i-text' || obj.type === 'textbox') {
            objects.push({
                type: 'text', text: obj.text, left: obj.left, top: obj.top,
                fontSize: obj.fontSize, fill: obj.fill,
                scaleX: obj.scaleX, scaleY: obj.scaleY, angle: obj.angle,
            });
        } else if (obj._shapeData) {
            objects.push({
                type: 'shape', ...obj._shapeData,
                left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY,
            });
        }
    }
    const vpt = fabricCanvas.viewportTransform;
    return { objects, viewport: { x: vpt[4], y: vpt[5], zoom: fabricCanvas.getZoom() } };
}


/**
 * Export the whole drawing (not just the visible viewport) as a PNG
 * data URL on a white background, for server-side OCR.
 */
function exportPng(fabricCanvas) {
    const objects = fabricCanvas.getObjects();
    if (objects.length === 0) return null;

    state.exporting = true;
    const savedVpt = fabricCanvas.viewportTransform.slice();
    const savedBg = fabricCanvas.backgroundColor;
    try {
        fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        fabricCanvas.backgroundColor = '#ffffff';

        // Bounding box of all content, with padding.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const obj of objects) {
            const b = obj.getBoundingRect(true);
            minX = Math.min(minX, b.left);
            minY = Math.min(minY, b.top);
            maxX = Math.max(maxX, b.left + b.width);
            maxY = Math.max(maxY, b.top + b.height);
        }
        const pad = 20;
        return fabricCanvas.toDataURL({
            format: 'png',
            left: minX - pad,
            top: minY - pad,
            width: (maxX - minX) + pad * 2,
            height: (maxY - minY) + pad * 2,
        });
    } catch (err) {
        console.error('PNG export failed:', err);
        return null;
    } finally {
        fabricCanvas.backgroundColor = savedBg;
        fabricCanvas.setViewportTransform(savedVpt);
        fabricCanvas.renderAll();
        state.exporting = false;
    }
}


// ── Section 12: Auto-Save ──────────────────────────────────────────────────

function markDirty() {
    state.dirty = true;
    showSaveStatus('Saving...');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(autoSave, AUTOSAVE_DELAY);
}

function showSaveStatus(text, isError) {
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('saved', 'saving', 'error');
    if (isError) el.classList.add('error');
    else if (text === 'Saved') el.classList.add('saved');
    else el.classList.add('saving');
}

function buildSavePayload() {
    const content = serializeCanvas(state.fabricCanvas);
    return {
        id: state.noteId,
        title: state.title || 'Untitled',
        kind: 'drawing',
        strokes_json: JSON.stringify(content),
        image_data_url: exportPng(state.fabricCanvas),
        tags: state.tags.join(','),
    };
}

async function autoSave() {
    if (!state.dirty || state.saving || !state.fabricCanvas) return;
    state.dirty = false;
    state.saving = true;
    try {
        const payload = buildSavePayload();
        // text/plain body dodges the gateway's 1mb JSON parser cap.
        const resp = await fetch(PM_BASE + '/api/pm/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!state.noteId && data.note && data.note.id) {
            state.noteId = data.note.id;
            try { history.replaceState(null, '', PM_BASE + '/pm/notes/' + state.noteId + '/edit'); } catch (_) { /* ok */ }
        }
        showSaveStatus('Saved');
    } catch (err) {
        console.error('Auto-save failed:', err);
        showSaveStatus('Save failed', true);
        state.dirty = true;
    } finally {
        state.saving = false;
    }
}

function syncSave() {
    if (!state.dirty || !state.fabricCanvas) return;
    state.dirty = false;
    try {
        const body = JSON.stringify(buildSavePayload());
        const url = PM_BASE + '/api/pm/notes';
        const sent = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        if (!sent) {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, false);
            xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
            xhr.send(body);
        }
    } catch (err) {
        console.error('Beacon save failed:', err);
    }
}

function bindPageLifecycle() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && state.dirty) {
            clearTimeout(state.saveTimer);
            syncSave();
        }
    });
    window.addEventListener('beforeunload', () => {
        if (state.dirty) {
            clearTimeout(state.saveTimer);
            syncSave();
        }
    });
}


// ── Section 13: Zoom ────────────────────────────────────────────────────────

function updateZoomIndicator() {
    const el = document.getElementById('zoom-indicator');
    if (!el || !state.fabricCanvas) return;
    el.textContent = Math.round(state.fabricCanvas.getZoom() * 100) + '%';
}

function bindZoomIndicator() {
    const el = document.getElementById('zoom-indicator');
    if (!el) return;
    el.addEventListener('click', () => {
        if (!state.fabricCanvas) return;
        state.fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        updateZoomIndicator();
        state.fabricCanvas.renderAll();
    });
}


// ── Section 14: Toolbar Bindings ────────────────────────────────────────────

function bindToolbar() {
    document.querySelectorAll('#side-toolbar .tool-btn[data-tool]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.activeTool = btn.dataset.tool;
            if (btn.dataset.shape) state.activeShape = btn.dataset.shape;

            document.querySelectorAll('#side-toolbar .tool-btn[data-tool]').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            updateCanvasMode();
            updateCursorStyle();
        });
    });

    document.querySelectorAll('#side-toolbar .color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.activeColor = swatch.dataset.color;
            document.querySelectorAll('#side-toolbar .color-swatch').forEach(s => {
                s.classList.toggle('active', s === swatch);
            });
        });
    });

    document.querySelectorAll('#side-toolbar .size-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.activeSize = parseInt(btn.dataset.size, 10);
            document.querySelectorAll('#side-toolbar .size-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
        });
    });

    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undo(); });
    if (redoBtn) redoBtn.addEventListener('click', (e) => { e.stopPropagation(); redo(); });

    const addTagBtn = document.getElementById('btn-add-tag');
    if (addTagBtn) {
        addTagBtn.addEventListener('click', () => {
            const name = prompt('Tag name:');
            if (name && name.trim()) {
                state.tags.push(name.trim());
                renderTagChips();
                markDirty();
            }
        });
    }

    const ocrBtn = document.getElementById('btn-ocr');
    if (ocrBtn) {
        ocrBtn.addEventListener('click', async () => {
            if (!state.noteId) { alert('Save the note first (draw something).'); return; }
            ocrBtn.textContent = 'OCR…';
            ocrBtn.disabled = true;
            try {
                // Make sure the latest snapshot is on the server first.
                if (state.dirty) { clearTimeout(state.saveTimer); await autoSave(); }
                const resp = await fetch(PM_BASE + '/api/pm/notes/' + state.noteId + '/ocr', { method: 'POST' });
                const data = await resp.json();
                ocrBtn.textContent = resp.ok ? 'OCR done' : 'OCR';
                if (!resp.ok) alert('OCR failed: ' + (data.error || 'Unknown error'));
            } catch (err) {
                ocrBtn.textContent = 'OCR';
                alert('OCR error: ' + err.message);
            } finally {
                ocrBtn.disabled = false;
            }
        });
    }
}

function renderTagChips() {
    const container = document.getElementById('tag-chips');
    if (!container) return;
    const addBtn = document.getElementById('btn-add-tag');
    container.querySelectorAll('.tag-chip').forEach(c => c.remove());
    state.tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip removable';
        chip.dataset.tag = tag;
        chip.appendChild(document.createTextNode(tag + ' '));
        const rb = document.createElement('button');
        rb.className = 'tag-remove';
        rb.type = 'button';
        rb.textContent = '×';
        rb.addEventListener('click', () => {
            state.tags = state.tags.filter(t => t !== tag);
            renderTagChips();
            markDirty();
        });
        chip.appendChild(rb);
        container.insertBefore(chip, addBtn);
    });
}


function updateCanvasMode() {
    if (!state.fabricCanvas) return;

    if (state.activeTool === 'select') {
        state.fabricCanvas.selection = true;
        state.fabricCanvas.forEachObject(obj => { obj.selectable = true; obj.evented = true; });
    } else {
        state.fabricCanvas.selection = false;
        state.fabricCanvas.discardActiveObject();
        state.fabricCanvas.forEachObject(obj => { obj.selectable = false; obj.evented = false; });
    }

    if (state.previewShape) { state.fabricCanvas.remove(state.previewShape); state.previewShape = null; }
    if (state.previewPath) { state.fabricCanvas.remove(state.previewPath); state.previewPath = null; }
    state.isDrawing = false;
    state.currentStroke = null;
    state.shapeStart = null;
    state.fabricCanvas.renderAll();
}


function updateCursorStyle() {
    const container = document.getElementById('whiteboard-area');
    if (container) container.setAttribute('data-tool', state.activeTool);
}


// ── Section 16: Title Save ──────────────────────────────────────────────────

function bindTitleSave() {
    const titleInput = document.getElementById('note-title');
    if (!titleInput) return;
    titleInput.addEventListener('input', () => {
        state.title = titleInput.value;
        markDirty();
    });
}


// ── Section 17: Keyboard Shortcuts ──────────────────────────────────────────

function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.contentEditable === 'true')) return;

        if (e.code === 'Space' && !state.spaceHeld) {
            state.spaceHeld = true;
            const c = document.getElementById('whiteboard-area');
            if (c) c.classList.add('panning');
            e.preventDefault();
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }

        if ((e.key === 'Delete' || e.key === 'Backspace') && state.activeTool === 'select' && state.fabricCanvas) {
            const active = state.fabricCanvas.getActiveObjects();
            if (active && active.length > 0) {
                active.forEach(obj => state.fabricCanvas.remove(obj));
                state.fabricCanvas.discardActiveObject();
                state.fabricCanvas.renderAll();
                pushUndoState();
                markDirty();
                e.preventDefault();
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            state.spaceHeld = false;
            const c = document.getElementById('whiteboard-area');
            if (c) c.classList.remove('panning');
        }
    });
}
