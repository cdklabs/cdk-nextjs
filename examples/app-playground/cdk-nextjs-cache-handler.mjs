const require = (await import('node:module')).createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports, module) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js
var require_common = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js"(exports, module) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug(...args) {
          if (!debug.enabled) {
            return;
          }
          const self = debug;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self.diff = ms;
          self.prev = prevTime;
          self.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self, args);
          const logFn = self.log || createDebug.log;
          logFn.apply(self, args);
        }
        debug.namespace = namespace;
        debug.useColors = createDebug.useColors();
        debug.color = createDebug.selectColor(namespace);
        debug.extend = extend;
        debug.destroy = createDebug.destroy;
        Object.defineProperty(debug, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug);
        }
        return debug;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module.exports = setup;
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js"(exports, module) {
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = localstorage();
    exports.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports.storage.setItem("debug", namespaces);
        } else {
          exports.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports.storage.getItem("debug") || exports.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// node_modules/.pnpm/has-flag@3.0.0/node_modules/has-flag/index.js
var require_has_flag = __commonJS({
  "node_modules/.pnpm/has-flag@3.0.0/node_modules/has-flag/index.js"(exports, module) {
    "use strict";
    module.exports = (flag, argv) => {
      argv = argv || process.argv;
      const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
      const pos = argv.indexOf(prefix + flag);
      const terminatorPos = argv.indexOf("--");
      return pos !== -1 && (terminatorPos === -1 ? true : pos < terminatorPos);
    };
  }
});

// node_modules/.pnpm/supports-color@5.5.0/node_modules/supports-color/index.js
var require_supports_color = __commonJS({
  "node_modules/.pnpm/supports-color@5.5.0/node_modules/supports-color/index.js"(exports, module) {
    "use strict";
    var os = __require("os");
    var hasFlag = require_has_flag();
    var env = process.env;
    var forceColor;
    if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false")) {
      forceColor = false;
    } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
      forceColor = true;
    }
    if ("FORCE_COLOR" in env) {
      forceColor = env.FORCE_COLOR.length === 0 || parseInt(env.FORCE_COLOR, 10) !== 0;
    }
    function translateLevel(level) {
      if (level === 0) {
        return false;
      }
      return {
        level,
        hasBasic: true,
        has256: level >= 2,
        has16m: level >= 3
      };
    }
    function supportsColor(stream) {
      if (forceColor === false) {
        return 0;
      }
      if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
        return 3;
      }
      if (hasFlag("color=256")) {
        return 2;
      }
      if (stream && !stream.isTTY && forceColor !== true) {
        return 0;
      }
      const min = forceColor ? 1 : 0;
      if (process.platform === "win32") {
        const osRelease = os.release().split(".");
        if (Number(process.versions.node.split(".")[0]) >= 8 && Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
          return Number(osRelease[2]) >= 14931 ? 3 : 2;
        }
        return 1;
      }
      if ("CI" in env) {
        if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
          return 1;
        }
        return min;
      }
      if ("TEAMCITY_VERSION" in env) {
        return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
      }
      if (env.COLORTERM === "truecolor") {
        return 3;
      }
      if ("TERM_PROGRAM" in env) {
        const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
        switch (env.TERM_PROGRAM) {
          case "iTerm.app":
            return version >= 3 ? 3 : 2;
          case "Apple_Terminal":
            return 2;
        }
      }
      if (/-256(color)?$/i.test(env.TERM)) {
        return 2;
      }
      if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
        return 1;
      }
      if ("COLORTERM" in env) {
        return 1;
      }
      if (env.TERM === "dumb") {
        return min;
      }
      return min;
    }
    function getSupportLevel(stream) {
      const level = supportsColor(stream);
      return translateLevel(level);
    }
    module.exports = {
      supportsColor: getSupportLevel,
      stdout: getSupportLevel(process.stdout),
      stderr: getSupportLevel(process.stderr)
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js
var require_node = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js"(exports, module) {
    var tty = __require("tty");
    var util = __require("util");
    exports.init = init;
    exports.log = log;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = require_supports_color();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports.inspectOpts ? Boolean(exports.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js
var require_src = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js"(exports, module) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module.exports = require_browser();
    } else {
      module.exports = require_node();
    }
  }
});

// src/nextjs-build/cdk-nextjs-cache-handler.ts
var import_debug3 = __toESM(require_src());

// src/nextjs-build/memory-cache-handler.ts
var import_debug = __toESM(require_src());
var MemoryCacheHandler = class {
  constructor(options) {
    this.inMemoryCache = /* @__PURE__ */ new Map();
    this.inMemoryTagCache = /* @__PURE__ */ new Map();
    this.debug = (0, import_debug.default)("cdk-nextjs-cache-handler:memory");
    this.ttlMs = options.ttlMs || 6e4;
    this.fallbackHandler = options.fallbackHandler;
    if (options.context.dev) {
      this.debug("MemoryCacheHandler initialized in development mode");
    }
  }
  async get(cacheKey, ctx) {
    if (ctx.kind) {
      this.debug(
        `Memory cache get operation for ${cacheKey} with kind: ${ctx.kind}`
      );
    }
    const memoryEntry = this.inMemoryCache.get(cacheKey);
    if (memoryEntry && this.isEntryValid(memoryEntry)) {
      return memoryEntry.value;
    }
    if (memoryEntry && !this.isEntryValid(memoryEntry)) {
      this.inMemoryCache.delete(cacheKey);
    }
    if (this.fallbackHandler) {
      const fallbackValue = await this.fallbackHandler.get(cacheKey, ctx);
      if (fallbackValue) {
        this.inMemoryCache.set(cacheKey, {
          value: fallbackValue,
          timestamp: Date.now()
        });
        return fallbackValue;
      }
    }
    return null;
  }
  async set(cacheKey, data, ctx) {
    if (!data) {
      return;
    }
    if (ctx.tags && ctx.tags.length > 0) {
      this.debug(`Memory cache entry for ${cacheKey} has tags:`, ctx.tags);
    }
    const cacheHandlerValue = {
      lastModified: Date.now(),
      value: data
    };
    this.inMemoryCache.set(cacheKey, {
      value: cacheHandlerValue,
      timestamp: Date.now()
    });
    if (ctx.tags && ctx.tags.length > 0) {
      for (const tag of ctx.tags) {
        let tagSet = this.inMemoryTagCache.get(tag);
        if (!tagSet) {
          tagSet = /* @__PURE__ */ new Set();
          this.inMemoryTagCache.set(tag, tagSet);
        }
        tagSet.add(cacheKey);
      }
    }
    if (this.fallbackHandler) {
      await this.fallbackHandler.set(cacheKey, data, ctx);
    }
  }
  async revalidateTag(tag) {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const t of tags) {
      this.clearMemoryCacheByTag(t);
    }
    if (this.fallbackHandler) {
      await this.fallbackHandler.revalidateTag(tag);
    }
  }
  async resetRequestCache() {
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();
    if (this.fallbackHandler) {
      await this.fallbackHandler.resetRequestCache();
    }
  }
  isEntryValid(entry) {
    return Date.now() - entry.timestamp < this.ttlMs;
  }
  clearMemoryCacheByTag(tag) {
    const cacheKeys = this.inMemoryTagCache.get(tag);
    if (cacheKeys) {
      for (const cacheKey of cacheKeys) {
        this.inMemoryCache.delete(cacheKey);
      }
      this.inMemoryTagCache.delete(tag);
      for (const [otherTag, otherKeys] of this.inMemoryTagCache.entries()) {
        for (const cacheKey of cacheKeys) {
          otherKeys.delete(cacheKey);
        }
        if (otherKeys.size === 0) {
          this.inMemoryTagCache.delete(otherTag);
        }
      }
    }
  }
  // Public methods for testing and monitoring
  getCacheSize() {
    return this.inMemoryCache.size;
  }
  getTagCacheSize() {
    return this.inMemoryTagCache.size;
  }
  clearCache() {
    this.inMemoryCache.clear();
    this.inMemoryTagCache.clear();
  }
  getHealthStatus() {
    return {
      memoryCacheSize: this.inMemoryCache.size,
      tagCacheSize: this.inMemoryTagCache.size,
      ttlMs: this.ttlMs,
      hasFallbackHandler: !!this.fallbackHandler
    };
  }
};

// src/nextjs-build/s3-dynamo-cache-handler.ts
var import_debug2 = __toESM(require_src());
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
function isNextBuild() {
  return process.env["NEXT_PHASE"] === "phase-production-build";
}
var S3DynamoCacheHandler = class {
  constructor(options) {
    this.circuitBreaker = {
      s3Failures: 0,
      dynamoFailures: 0,
      lastFailureTime: 0
    };
    this.debug = (0, import_debug2.default)("cdk-nextjs-cache-handler:s3-dynamo");
    const buildId = process.env.CDK_NEXTJS_BUILD_ID || "";
    this.s3Config = {
      bucketName: options.s3Config?.bucketName || process.env.CDK_NEXTJS_CACHE_BUCKET_NAME || "",
      region: options.s3Config?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.s3Config?.buildId || buildId
    };
    this.dynamoConfig = {
      tableName: options.dynamoConfig?.tableName || process.env.CDK_NEXTJS_REVALIDATION_TABLE_NAME || "",
      region: options.dynamoConfig?.region || process.env.AWS_REGION || "us-east-1",
      buildId: options.dynamoConfig?.buildId || buildId
    };
    this.circuitBreakerThreshold = options.circuitBreakerThreshold || 5;
    this.circuitBreakerTimeoutMs = options.circuitBreakerTimeoutMs || 3e5;
    this.s3Client = new S3Client({ region: this.s3Config.region });
    this.dynamoClient = new DynamoDBClient({
      region: this.dynamoConfig.region
    });
    if (!isNextBuild()) {
      if (!this.s3Config.bucketName) {
        console.warn(
          "CDK_NEXTJS_CACHE_BUCKET_NAME environment variable not set, S3 cache disabled"
        );
      }
      if (!this.dynamoConfig.tableName) {
        console.warn(
          "CDK_NEXTJS_REVALIDATION_TABLE_NAME environment variable not set, revalidation tracking disabled"
        );
      }
      if (!buildId) {
        console.warn(
          "CDK_NEXTJS_BUILD_ID environment variable not set, cache isolation may not work correctly"
        );
      }
    }
    if (options.context.dev) {
      this.debug("S3DynamoCacheHandler initialized in development mode");
    }
  }
  async get(cacheKey, ctx) {
    try {
      if (ctx.kind) {
        this.debug(
          `S3 cache get operation for ${cacheKey} with kind: ${ctx.kind}`
        );
      }
      if (this.isS3CircuitOpen()) {
        this.debug("S3 circuit breaker is open, returning cache miss");
        return null;
      }
      if (!this.s3Config.bucketName) {
        return null;
      }
      const s3Key = this.buildS3Key(cacheKey);
      const command = new GetObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key
      });
      const response = await this.s3Client.send(command);
      if (!response.Body) {
        return null;
      }
      let cacheValue;
      const contentType = response.ContentType || "application/json";
      const bodyString = await response.Body.transformToString("utf-8");
      if (contentType.includes("application/json")) {
        cacheValue = JSON.parse(bodyString);
      } else {
        return null;
      }
      this.circuitBreaker.s3Failures = 0;
      return cacheValue;
    } catch (error) {
      const errorType = this.categorizeError(error);
      console.error(`Error retrieving cache from S3 (${errorType}):`, error);
      this.handleS3Failure();
      return null;
    }
  }
  async set(cacheKey, data, ctx) {
    try {
      if (!data) {
        return;
      }
      if (ctx.tags && ctx.tags.length > 0) {
        this.debug(`S3 cache entry for ${cacheKey} has tags:`, ctx.tags);
      }
      if (this.isS3CircuitOpen()) {
        this.debug("S3 circuit breaker is open, skipping S3 storage");
        return;
      }
      if (!this.s3Config.bucketName) {
        return;
      }
      const s3Key = this.buildS3Key(cacheKey);
      const cacheHandlerValue = {
        lastModified: Date.now(),
        value: data
      };
      const body = JSON.stringify(cacheHandlerValue);
      const command = new PutObjectCommand({
        Bucket: this.s3Config.bucketName,
        Key: s3Key,
        Body: body,
        ContentType: "application/json; charset=utf-8",
        // Always JSON since we store CacheHandlerValue
        ContentEncoding: "utf-8",
        Metadata: {
          cacheKey,
          buildId: this.s3Config.buildId,
          timestamp: Date.now().toString()
        }
      });
      await this.s3Client.send(command);
      if (ctx.tags && ctx.tags.length > 0 && this.dynamoConfig.tableName) {
        await this.storeDynamoDBTagMappings(cacheKey, ctx.tags);
      }
      this.circuitBreaker.s3Failures = 0;
    } catch (error) {
      const errorType = this.categorizeError(error);
      console.error(`Error storing cache to S3 (${errorType}):`, error);
      this.handleS3Failure();
    }
  }
  async revalidateTag(tag) {
    const tags = Array.isArray(tag) ? tag : [tag];
    try {
      if (this.isDynamoCircuitOpen()) {
        this.debug(
          "DynamoDB circuit breaker is open, skipping revalidation tracking"
        );
        return;
      }
      if (!this.dynamoConfig.tableName) {
        return;
      }
      for (const t of tags) {
        await this.revalidateSingleTag(t);
      }
      this.circuitBreaker.dynamoFailures = 0;
    } catch (error) {
      console.error("Error updating revalidation metadata:", error);
      this.handleDynamoFailure();
    }
  }
  async revalidateSingleTag(tag) {
    const tagWithBuildId = `${this.dynamoConfig.buildId}#${tag}`;
    const queryCommand = new QueryCommand({
      TableName: this.dynamoConfig.tableName,
      KeyConditionExpression: "tag = :tag",
      ExpressionAttributeValues: {
        ":tag": { S: tagWithBuildId }
      }
    });
    const queryResponse = await this.dynamoClient.send(queryCommand);
    if (queryResponse.Items) {
      const updatePromises = queryResponse.Items.map(async (item) => {
        const cacheKey = item.cacheKey?.S;
        if (cacheKey) {
          const updateCommand = new UpdateItemCommand({
            TableName: this.dynamoConfig.tableName,
            Key: {
              tag: { S: tagWithBuildId },
              cacheKey: { S: cacheKey }
            },
            UpdateExpression: "SET revalidatedAt = :timestamp",
            ExpressionAttributeValues: {
              ":timestamp": { N: Date.now().toString() }
            }
          });
          return this.dynamoClient.send(updateCommand);
        }
        return Promise.resolve();
      });
      await Promise.all(updatePromises.filter(Boolean));
      if (this.s3Config.bucketName) {
        const deletePromises = queryResponse.Items.map(async (item) => {
          const cacheKey = item.cacheKey?.S;
          if (cacheKey) {
            const s3Key = this.buildS3Key(cacheKey);
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.s3Config.bucketName,
              Key: s3Key
            });
            try {
              await this.s3Client.send(deleteCommand);
            } catch (error) {
              console.warn(`Failed to delete S3 cache entry ${s3Key}:`, error);
            }
          }
        });
        await Promise.all(deletePromises.filter(Boolean));
      }
    }
  }
  async resetRequestCache() {
  }
  buildS3Key(cacheKey) {
    return `/${this.s3Config.buildId}/${cacheKey}`;
  }
  async storeDynamoDBTagMappings(cacheKey, tags) {
    try {
      if (this.isDynamoCircuitOpen()) {
        this.debug(
          "DynamoDB circuit breaker is open, skipping tag mapping storage"
        );
        return;
      }
      const updatePromises = tags.map(async (tag) => {
        const tagWithBuildId = `${this.dynamoConfig.buildId}#${tag}`;
        const updateCommand = new UpdateItemCommand({
          TableName: this.dynamoConfig.tableName,
          Key: {
            tag: { S: tagWithBuildId },
            cacheKey: { S: cacheKey }
          },
          UpdateExpression: "SET createdAt = if_not_exists(createdAt, :now), revalidatedAt = :now",
          ExpressionAttributeValues: {
            ":now": { N: Date.now().toString() }
          }
        });
        await this.dynamoClient.send(updateCommand);
      });
      await Promise.all(updatePromises);
      this.circuitBreaker.dynamoFailures = 0;
    } catch (error) {
      console.error("Error storing DynamoDB tag mappings:", error);
      this.handleDynamoFailure();
    }
  }
  isS3CircuitOpen() {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;
    if (this.circuitBreaker.s3Failures >= this.circuitBreakerThreshold && timeSinceLastFailure < this.circuitBreakerTimeoutMs) {
      return true;
    }
    if (timeSinceLastFailure > this.circuitBreakerTimeoutMs) {
      this.circuitBreaker.s3Failures = 0;
    }
    return false;
  }
  isDynamoCircuitOpen() {
    const now = Date.now();
    const timeSinceLastFailure = now - this.circuitBreaker.lastFailureTime;
    if (this.circuitBreaker.dynamoFailures >= this.circuitBreakerThreshold && timeSinceLastFailure < this.circuitBreakerTimeoutMs) {
      return true;
    }
    if (timeSinceLastFailure > this.circuitBreakerTimeoutMs) {
      this.circuitBreaker.dynamoFailures = 0;
    }
    return false;
  }
  handleS3Failure() {
    this.circuitBreaker.s3Failures++;
    this.circuitBreaker.lastFailureTime = Date.now();
    console.error(
      `S3 Cache Handler: Failure count ${this.circuitBreaker.s3Failures}/${this.circuitBreakerThreshold}. Circuit breaker will open at ${this.circuitBreakerThreshold} failures.`
    );
    if (this.circuitBreaker.s3Failures >= this.circuitBreakerThreshold) {
      console.error(
        "S3 Cache Handler: Circuit breaker opened due to repeated failures."
      );
    }
  }
  handleDynamoFailure() {
    this.circuitBreaker.dynamoFailures++;
    this.circuitBreaker.lastFailureTime = Date.now();
    console.error(
      `DynamoDB Revalidation: Failure count ${this.circuitBreaker.dynamoFailures}/${this.circuitBreakerThreshold}. Circuit breaker will open at ${this.circuitBreakerThreshold} failures.`
    );
    if (this.circuitBreaker.dynamoFailures >= this.circuitBreakerThreshold) {
      console.error(
        "DynamoDB Revalidation: Circuit breaker opened due to repeated failures. Revalidation tracking disabled."
      );
    }
  }
  // Enhanced error categorization
  categorizeError(error) {
    if (error.name === "NetworkingError" || error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return "network";
    }
    if (error.name === "AccessDenied" || error.code === "AccessDenied" || error.statusCode === 403) {
      return "permission";
    }
    if (error.name === "ThrottlingException" || error.code === "ThrottlingException" || error.statusCode === 429) {
      return "throttling";
    }
    return "unknown";
  }
  // Public methods for testing and monitoring
  getHealthStatus() {
    return {
      s3Available: !this.isS3CircuitOpen(),
      dynamoAvailable: !this.isDynamoCircuitOpen(),
      circuitBreakerStatus: {
        s3Failures: this.circuitBreaker.s3Failures,
        dynamoFailures: this.circuitBreaker.dynamoFailures,
        lastFailureTime: this.circuitBreaker.lastFailureTime
      },
      config: {
        s3Config: this.s3Config,
        dynamoConfig: this.dynamoConfig,
        circuitBreakerThreshold: this.circuitBreakerThreshold,
        circuitBreakerTimeoutMs: this.circuitBreakerTimeoutMs
      }
    };
  }
  // Method to manually reset circuit breakers (for operational purposes)
  resetCircuitBreakers() {
    this.circuitBreaker.s3Failures = 0;
    this.circuitBreaker.dynamoFailures = 0;
    this.circuitBreaker.lastFailureTime = 0;
    console.info("S3DynamoCacheHandler: Circuit breakers manually reset");
  }
};

// src/nextjs-build/cdk-nextjs-cache-handler.ts
var CdkNextjsCacheHandler = class extends MemoryCacheHandler {
  constructor(options) {
    const s3DynamoHandler = new S3DynamoCacheHandler({
      context: options
    });
    super({
      context: options,
      ttlMs: 6e4,
      // 1 minute TTL for memory cache
      fallbackHandler: s3DynamoHandler
    });
    this.compositeDebug = (0, import_debug3.default)("cdk-nextjs-cache-handler:composite");
    this.s3DynamoHandler = s3DynamoHandler;
    if (options.dev) {
      this.compositeDebug(
        "CdkNextjsCacheHandler initialized with memory + S3/DynamoDB layers"
      );
    }
  }
  // Expose health status from both layers with a different method name to avoid override issues
  getCompositeHealthStatus() {
    const memoryStatus = super.getHealthStatus();
    const s3DynamoStatus = this.s3DynamoHandler.getHealthStatus();
    return {
      memoryLayer: memoryStatus,
      s3DynamoLayer: s3DynamoStatus
    };
  }
  // Expose circuit breaker reset from S3/DynamoDB layer
  resetCircuitBreakers() {
    if (this.s3DynamoHandler?.resetCircuitBreakers) {
      this.s3DynamoHandler.resetCircuitBreakers();
    }
  }
};
export {
  CdkNextjsCacheHandler as default
};
