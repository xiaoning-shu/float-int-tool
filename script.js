const FORMAT_DEFS = [
  { key: "f16", title: "16-bit (half)", bits: 16, expBits: 5, fracBits: 10, bias: 15, hexDigits: 4 },
  { key: "f32", title: "32-bit (float)", bits: 32, expBits: 8, fracBits: 23, bias: 127, hexDigits: 8 },
  { key: "f64", title: "64-bit (double)", bits: 64, expBits: 11, fracBits: 52, bias: 1023, hexDigits: 16 },
  { key: "f80", title: "80-bit (extended)", bits: 80, expBits: 15, fracBits: 64, bias: 16383, hexDigits: 20, explicitInteger: true }
];

const state = new Map();
const formatsEl = document.querySelector("#formats");
const globalInput = document.querySelector("#globalDecimal");
const applyGlobal = document.querySelector("#applyGlobal");
const valueState = document.querySelector("#valueState");
const themeToggle = document.querySelector("#themeToggle");
const themeMeta = document.querySelector('meta[name="theme-color"]');

function bitsFromBigInt(value, totalBits) {
  return Array.from({ length: totalBits }, (_, index) => {
    const shift = BigInt(totalBits - 1 - index);
    return Number((value >> shift) & 1n);
  });
}

function bigIntFromBits(bits) {
  return bits.reduce((value, bit) => (value << 1n) | BigInt(bit), 0n);
}

function sanitizeHex(value, digits) {
  const cleaned = value.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return cleaned.slice(-digits).padStart(digits, "0");
}

function bitsToHex(bits, digits) {
  return bigIntFromBits(bits).toString(16).toUpperCase().padStart(digits, "0");
}

function hexToBits(hex, totalBits) {
  return bitsFromBigInt(BigInt(`0x${hex}`), totalBits);
}

function parseDecimal(raw) {
  const text = raw.trim();
  if (/^[+-]?inf(inity)?$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^nan$/i.test(text)) return NaN;
  if (Object.is(Number(text), -0) || text === "-0") return -0;
  return Number(text);
}

function decimalToFloat32Bits(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  return bitsFromBigInt(BigInt(view.getUint32(0, false)), 32);
}

function decimalToFloat64Bits(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return bitsFromBigInt(view.getBigUint64(0, false), 64);
}

function decimalToFloat16Bits(value) {
  if (Number.isNaN(value)) return hexToBits("7E00", 16);
  const sign = Object.is(value, -0) || value < 0 ? 1 : 0;
  const abs = Math.abs(value);
  if (abs === 0) return bitsFromBigInt(BigInt(sign) << 15n, 16);
  if (!Number.isFinite(abs)) return bitsFromBigInt((BigInt(sign) << 15n) | 0x7C00n, 16);

  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = abs;
  const x = u32[0];
  let half = ((x >> 16) & 0x8000) | ((((x >> 23) & 0xff) - 112) << 10) | ((x >> 13) & 0x03ff);
  if (((x >> 23) & 0xff) < 113) {
    const mantissa = (x & 0x7fffff) | 0x800000;
    const shift = 125 - ((x >> 23) & 0xff);
    half = ((x >> 16) & 0x8000) | (mantissa >> shift);
  } else if (((x >> 23) & 0xff) > 142) {
    half = ((x >> 16) & 0x8000) | 0x7c00;
  }

  half += (x >> 12) & 1;
  return bitsFromBigInt(BigInt((sign << 15) | (half & 0x7fff)), 16);
}

function decimalToFloat80Bits(value) {
  if (Number.isNaN(value)) return hexToBits("7FFFC000000000000000", 80);
  const sign = Object.is(value, -0) || value < 0 ? 1n : 0n;
  const abs = Math.abs(value);
  if (abs === 0) return bitsFromBigInt(sign << 79n, 80);
  if (!Number.isFinite(abs)) return bitsFromBigInt((sign << 79n) | (0x7FFFn << 64n) | (1n << 63n), 80);

  const exponent = Math.floor(Math.log2(abs));
  const scaled = abs / 2 ** exponent;
  let significand = BigInt(Math.round(scaled * 2 ** 63));
  let biased = exponent + 16383;

  if (significand >= (1n << 64n)) {
    significand >>= 1n;
    biased += 1;
  }

  if (biased <= 0) {
    const subScaled = abs / 2 ** (1 - 16383);
    significand = BigInt(Math.round(subScaled * 2 ** 63));
    biased = 0;
  }

  if (biased >= 0x7fff) {
    return bitsFromBigInt((sign << 79n) | (0x7FFFn << 64n) | (1n << 63n), 80);
  }

  return bitsFromBigInt((sign << 79n) | (BigInt(biased) << 64n) | significand, 80);
}

function decimalToBits(format, value) {
  if (format.key === "f16") return decimalToFloat16Bits(value);
  if (format.key === "f32") return decimalToFloat32Bits(value);
  if (format.key === "f64") return decimalToFloat64Bits(value);
  return decimalToFloat80Bits(value);
}

function decodeBits(format, bits) {
  const sign = bits[0] ? -1 : 1;
  const expStart = 1;
  const expEnd = expStart + format.expBits;
  const exponentBits = bits.slice(expStart, expEnd);
  const fractionBits = bits.slice(expEnd);
  const exponentRaw = Number(bigIntFromBits(exponentBits));
  const exponentMax = 2 ** format.expBits - 1;

  if (format.key === "f32") {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(bigIntFromBits(bits)), false);
    return buildDecoded(format, bits, sign, exponentRaw, exponentMax, view.getFloat32(0, false));
  }

  if (format.key === "f64") {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bigIntFromBits(bits), false);
    return buildDecoded(format, bits, sign, exponentRaw, exponentMax, view.getFloat64(0, false));
  }

  return buildDecoded(format, bits, sign, exponentRaw, exponentMax, null);
}

function buildDecoded(format, bits, sign, exponentRaw, exponentMax, nativeValue) {
  const fractionBits = bits.slice(1 + format.expBits);
  const fractionValue = fractionBits.reduce((sum, bit, index) => sum + bit * 2 ** -(index + 1), 0);
  const explicitInteger = format.explicitInteger ? fractionBits[0] : 1;
  const tailBits = format.explicitInteger ? fractionBits.slice(1) : fractionBits;
  const tailValue = tailBits.reduce((sum, bit, index) => sum + bit * 2 ** -(index + 1), 0);

  let classification = "normal";
  let exponent = exponentRaw - format.bias;
  let significand = format.explicitInteger ? explicitInteger + tailValue : 1 + fractionValue;
  let decimal = nativeValue;

  if (exponentRaw === 0) {
    classification = tailBits.some(Boolean) || (!format.explicitInteger && fractionBits.some(Boolean)) ? "subnormal" : "zero";
    exponent = 1 - format.bias;
    significand = format.explicitInteger ? tailValue : fractionValue;
  } else if (exponentRaw === exponentMax) {
    const hasPayload = format.explicitInteger ? tailBits.some(Boolean) || explicitInteger === 0 : fractionBits.some(Boolean);
    classification = hasPayload ? "NaN" : "infinity";
    decimal = hasPayload ? NaN : sign * Infinity;
  }

  if (decimal === null && classification !== "NaN" && classification !== "infinity") {
    decimal = sign * 2 ** exponent * significand;
  }

  return {
    sign,
    exponentRaw,
    exponent,
    significand,
    decimal,
    classification,
    signText: sign < 0 ? "-1" : "1"
  };
}

function formatDecimal(value) {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value < 0 ? "-Infinity" : "Infinity";
  if (Object.is(value, -0)) return "-0";
  return Number(value).toPrecision(17).replace(/\.?0+($|e)/, "$1");
}

function renderEquation(decoded) {
  if (decoded.classification === "NaN") return `<span class="special">NaN payload</span>`;
  if (decoded.classification === "infinity") return `<span class="special">${decoded.sign < 0 ? "-" : "+"}Infinity</span>`;
  if (decoded.classification === "zero") {
    return `<span class="equation-chip result">${decoded.sign < 0 ? "-0" : "0"}</span>`;
  }
  return `
    <span class="equation-chip sign">${decoded.signText}</span>
    <span>x</span>
    <span class="equation-chip exp"><span class="power-base">2</span><span class="power-exp">${decoded.exponent}</span></span>
    <span>x</span>
    <span class="equation-chip frac">${decoded.significand.toPrecision(17)}</span>
    <span>=</span>
    <span class="equation-chip result decimal-output">${formatDecimal(decoded.decimal)}</span>
  `;
}

function bitClass(format, index) {
  if (index === 0) return "sign-bit";
  if (index <= format.expBits) return "exp-bit";
  return "frac-bit";
}

function bitBoundaryClass(format, index) {
  if (index === 0) return "group-start group-end";
  if (index === 1) return "group-start";
  if (index === format.expBits) return "group-end";
  if (index === format.expBits + 1) return "group-start";
  if (index === format.bits - 1) return "group-end";
  return "";
}

function createFormat(format) {
  const card = document.createElement("article");
  card.className = "format-card";
  card.dataset.format = format.key;
  card.dataset.index = String(FORMAT_DEFS.indexOf(format) + 1).padStart(2, "0");
  card.innerHTML = `
    <div class="format-header">
      <div class="format-title-wrap">
        <span class="format-icon">${format.bits}</span>
        <div>
          <h3 class="format-title">${format.title}<span class="classification">normal</span></h3>
          <div class="format-meta">${format.expBits} exponent bits / ${format.fracBits} significand bits / bias ${format.bias}</div>
        </div>
      </div>
      <div class="legend-row" aria-label="Bit field legend">
        <span class="legend-item"><span class="legend-dot sign"></span>sign</span>
        <span class="legend-item"><span class="legend-dot exp"></span>exponent</span>
        <span class="legend-item"><span class="legend-dot frac"></span>significand</span>
      </div>
    </div>
    <div class="format-body">
      <div class="bit-scroll"><div class="bit-grid" role="grid" aria-label="${format.title} bits"></div></div>
      <div class="edit-grid">
        <div class="field">
          <label for="${format.key}-hex">Hex</label>
          <input id="${format.key}-hex" class="hex-input" type="text" spellcheck="false">
        </div>
        <div class="field">
          <label for="${format.key}-decimal">Decimal</label>
          <input id="${format.key}-decimal" class="decimal-input" type="text" spellcheck="false">
        </div>
      </div>
      <div class="equation"></div>
    </div>
  `;

  const bitGrid = card.querySelector(".bit-grid");
  bitGrid.style.setProperty("--bit-count", format.bits);

  for (let index = 0; index < format.bits; index += 1) {
    const bitNumber = format.bits - index;
    const bitEl = document.createElement("button");
    bitEl.className = `bit ${bitClass(format, index)} ${bitBoundaryClass(format, index)}`;
    bitEl.type = "button";
    bitEl.dataset.index = String(index);
    bitEl.setAttribute("aria-label", `Toggle bit ${bitNumber}`);

    bitGrid.append(bitEl);
  }

  formatsEl.append(card);
  state.set(format.key, {
    format,
    card,
    bitGrid,
    bits: decimalToBits(format, Math.PI)
  });
}

function adjustBitDensity() {
  state.forEach(({ format, bitGrid }) => {
    const width = bitGrid.getBoundingClientRect().width;
    const cellWidth = width / format.bits;
    bitGrid.classList.toggle("compact", cellWidth < 28);
    bitGrid.classList.toggle("micro", cellWidth < 18);
  });
}

function updateFormat(key, options = {}) {
  const item = state.get(key);
  const { format, card, bits } = item;
  const decoded = decodeBits(format, bits);
  const hexInput = card.querySelector(".hex-input");
  const decimalInput = card.querySelector(".decimal-input");
  const equation = card.querySelector(".equation");
  const classification = card.querySelector(".classification");
  const bitButtons = card.querySelectorAll(".bit");

  bitButtons.forEach((button, index) => {
    button.textContent = bits[index];
    button.classList.toggle("on", bits[index] === 1);
    button.setAttribute("aria-pressed", bits[index] === 1 ? "true" : "false");
  });

  if (!options.keepHexFocus) hexInput.value = bitsToHex(bits, format.hexDigits);
  if (!options.keepDecimalFocus) decimalInput.value = formatDecimal(decoded.decimal);
  classification.textContent = decoded.classification;
  equation.innerHTML = renderEquation(decoded);
}

function setAllFromDecimal(raw) {
  const value = parseDecimal(raw);
  if (Number.isNaN(value)) {
    valueState.textContent = /^nan$/i.test(raw.trim()) ? "NAN" : "INVALID";
  } else if (!Number.isFinite(value)) {
    valueState.textContent = "INFINITY";
  } else if (value === 0) {
    valueState.textContent = "ZERO";
  } else {
    valueState.textContent = "NORMAL";
  }
  FORMAT_DEFS.forEach((format) => {
    const item = state.get(format.key);
    item.bits = decimalToBits(format, value);
    updateFormat(format.key);
  });
}

FORMAT_DEFS.forEach(createFormat);
FORMAT_DEFS.forEach((format) => updateFormat(format.key));
adjustBitDensity();

if ("ResizeObserver" in window) {
  const resizeObserver = new ResizeObserver(adjustBitDensity);
  state.forEach(({ card }) => resizeObserver.observe(card));
} else {
  window.addEventListener("resize", adjustBitDensity);
}

formatsEl.addEventListener("click", (event) => {
  const bit = event.target.closest(".bit");
  if (!bit) return;
  const card = bit.closest(".format-card");
  const item = state.get(card.dataset.format);
  const index = Number(bit.dataset.index);
  item.bits[index] = item.bits[index] ? 0 : 1;
  updateFormat(item.format.key);
});

formatsEl.addEventListener("input", (event) => {
  const card = event.target.closest(".format-card");
  if (!card) return;
  const item = state.get(card.dataset.format);

  if (event.target.classList.contains("hex-input")) {
    const hex = sanitizeHex(event.target.value, item.format.hexDigits);
    item.bits = hexToBits(hex, item.format.bits);
    updateFormat(item.format.key, { keepHexFocus: true });
  }

  if (event.target.classList.contains("decimal-input")) {
    const value = parseDecimal(event.target.value);
    if (Number.isNaN(value) && !/^nan$/i.test(event.target.value.trim())) return;
    item.bits = decimalToBits(item.format, value);
    updateFormat(item.format.key, { keepDecimalFocus: true });
  }
});

formatsEl.addEventListener("blur", (event) => {
  const card = event.target.closest(".format-card");
  if (!card) return;
  updateFormat(card.dataset.format);
}, true);

applyGlobal.addEventListener("click", () => setAllFromDecimal(globalInput.value));
globalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") setAllFromDecimal(globalInput.value);
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    globalInput.value = button.dataset.preset;
    setAllFromDecimal(button.dataset.preset);
  });
});

function syncThemeControl() {
  const isLight = document.documentElement.dataset.theme === "light";
  themeToggle.setAttribute("aria-pressed", isLight ? "true" : "false");
  themeToggle.querySelector(".theme-label").textContent = isLight ? "Dark mode" : "Light mode";
  themeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  themeMeta.setAttribute("content", isLight ? "#e8e9e5" : "#080b0d");
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("float-tool-theme", nextTheme);
  syncThemeControl();
});

syncThemeControl();
