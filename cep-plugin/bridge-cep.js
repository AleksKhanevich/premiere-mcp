/**
 * MCP Premiere Pro Bridge (CEP)
 * Uses CSInterface.evalScript to run ExtendScript in Premiere Pro.
 * Works in release Premiere Pro — no Beta or UXP Developer Tool required.
 */

(function() {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var EXTENDSCRIPT_COMPAT_HELPERS = [
        'function __mcpEscapeString(value) {',
        '    return String(value)',
        '        .replace(/\\\\/g, "\\\\\\\\")',
        "        .replace(/\"/g, '\\\\\"')",
        '        .replace(/\\r/g, "\\\\r")',
        '        .replace(/\\n/g, "\\\\n")',
        '        .replace(/\\t/g, "\\\\t");',
        '}',
        'function __mcpStringify(value) {',
        '    if (value === null) return "null";',
        '    var valueType = typeof value;',
        '    if (valueType === "string") return "\\"" + __mcpEscapeString(value) + "\\"";',
        '    if (valueType === "number") return isFinite(value) ? String(value) : "null";',
        '    if (valueType === "boolean") return value ? "true" : "false";',
        '    if (value instanceof Array) {',
        '        var arrayParts = [];',
        '        for (var i = 0; i < value.length; i++) {',
        '            arrayParts.push(__mcpStringify(value[i]));',
        '        }',
        '        return "[" + arrayParts.join(",") + "]";',
        '    }',
        '    if (valueType === "object") {',
        '        var objectParts = [];',
        '        for (var key in value) {',
        '            if (value.hasOwnProperty && !value.hasOwnProperty(key)) continue;',
        '            if (typeof value[key] === "undefined" || typeof value[key] === "function") continue;',
        '            objectParts.push(__mcpStringify(String(key)) + ":" + __mcpStringify(value[key]));',
        '        }',
        '        return "{" + objectParts.join(",") + "}";',
        '    }',
        '    return "null";',
        '}',
        'if (typeof JSON === "undefined") { JSON = {}; }',
        'if (typeof JSON.stringify !== "function") { JSON.stringify = __mcpStringify; }'
    ].join('\n');

    function getDefaultTempPath() {
        if (process.env.PREMIERE_TEMP_DIR) {
            return sanitizeTempDirectoryInput(process.env.PREMIERE_TEMP_DIR);
        }
        var base = (os.platform() === 'win32') ? (process.env.TEMP || process.env.TMP || 'C:\\Temp') : '/tmp';
        return path.join(base, 'premiere-mcp-bridge');
    }

    function getPanelConfigPath() {
        var configDir = path.join(os.homedir(), '.premiere-mcp-bridge');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        return path.join(configDir, 'config.json');
    }

    function ensureDirectory(dirPath) {
        if (!dirPath) return null;
        var resolvedPath = path.resolve(dirPath);
        if (!fs.existsSync(resolvedPath)) {
            fs.mkdirSync(resolvedPath, { recursive: true });
        }
        if (!fs.statSync(resolvedPath).isDirectory()) {
            throw new Error('Temp path is not a directory: ' + resolvedPath);
        }
        return resolvedPath;
    }

    function sanitizeTempDirectoryInput(value) {
        if (!value || typeof value !== 'string') return '';
        var trimmed = value.trim();

        function normalizePathLiteral(pathValue) {
            return pathValue.trim().replace(/\\\\/g, '\\');
        }

        try {
            if (trimmed.charAt(0) === '{') {
                var parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed.PREMIERE_TEMP_DIR === 'string') {
                    return normalizePathLiteral(parsed.PREMIERE_TEMP_DIR);
                }
                if (parsed && typeof parsed.tempDirectory === 'string') {
                    return normalizePathLiteral(parsed.tempDirectory);
                }
            }
        } catch (e) {}

        var envMatch = trimmed.match(/["']?PREMIERE_TEMP_DIR["']?\s*:\s*["']([^"']+)["']/);
        if (envMatch && envMatch[1]) {
            trimmed = normalizePathLiteral(envMatch[1]);
        } else {
            trimmed = normalizePathLiteral(trimmed.replace(/^["']|["']$/g, ''));
        }

        if (os.platform() === 'win32' && /^\/tmp(?:\/|$)/.test(trimmed)) {
            return '';
        }

        return trimmed;
    }

    function MCPPremiereBridge() {
        this.isConnected = false;
        this.tempDirectory = '';
        this.commandQueue = [];
        this.isProcessing = false;
        this.csInterface = new CSInterface();
        this.init();
    }

    MCPPremiereBridge.prototype.normalizeHostEnvironment = function(hostEnv) {
        if (!hostEnv) return null;
        if (typeof hostEnv === 'string') {
            return JSON.parse(hostEnv);
        }
        return hostEnv;
    };

    MCPPremiereBridge.prototype.init = function() {
        this.log('Initializing MCP Bridge (CEP)...', 'info');

        // Check host environment
        try {
            var env = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            if (env) {
                this.log('Premiere Pro version: ' + env.appVersion + ' (build ' + env.appId + ')', 'info');
            }
        } catch (e) {
            this.log('Warning: Could not get host environment: ' + e.message, 'warning');
        }

        this.loadConfig();
        this.updateUI();
        this.startCommandPolling();
    };

    MCPPremiereBridge.prototype.getTempDirectory = function() {
        var targetPath = this.tempDirectory || getDefaultTempPath();
        try {
            this.tempDirectory = ensureDirectory(targetPath);
            return this.tempDirectory;
        } catch (e) {
            this.log('Error creating temp directory: ' + e.message, 'error');
            return null;
        }
    };

    MCPPremiereBridge.prototype.getDiagnosticReportPath = function() {
        var tempDir = this.getTempDirectory();
        if (!tempDir) return null;
        return path.join(tempDir, 'premiere-mcp-diagnostics-latest.json');
    };

    MCPPremiereBridge.prototype.writeDiagnosticReport = function(report) {
        try {
            var reportPath = this.getDiagnosticReportPath();
            if (!reportPath) return null;
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            return reportPath;
        } catch (e) {
            this.log('Failed to write diagnostics report: ' + e.message, 'error');
            return null;
        }
    };

    MCPPremiereBridge.prototype.watchDirectory = function(dirPath) {
        try {
            var watchedPath = ensureDirectory(dirPath);
            var files = fs.readdirSync(watchedPath);
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                if (file.indexOf('command-') === 0 && file.indexOf('.json') === file.length - 5) {
                    this.processCommandFile(path.join(watchedPath, file));
                    return;
                }
            }
        } catch (e) {
            this.log('Error watching directory: ' + e.message, 'error');
        }
    };

    MCPPremiereBridge.prototype.processCommandFile = function(filePath) {
        var self = this;
        try {
            var fileContent = fs.readFileSync(filePath, 'utf8');
            var command = JSON.parse(fileContent);
            this.log('Processing command: ' + command.id, 'info');
            this.addToQueue(command);
            this.isProcessing = true;
            this.executeCommand(command, function(result) {
                try {
                    var responseFile = filePath.replace('command-', 'response-');
                    fs.writeFileSync(responseFile, JSON.stringify(result, null, 2));
                    fs.unlinkSync(filePath);
                    self.log('Command completed: ' + command.id, 'info');
                    self.updateCommandStatus(command.id, 'completed');
                } catch (e) {
                    var errFile = filePath.replace('command-', 'response-');
                    fs.writeFileSync(errFile, JSON.stringify({ error: e.message, timestamp: new Date().toISOString() }, null, 2));
                }
                self.isProcessing = false;
            });
        } catch (e) {
            this.log('Error processing command file: ' + e.message, 'error');
            try {
                var responseFile = filePath.replace('command-', 'response-');
                fs.writeFileSync(responseFile, JSON.stringify({ error: e.message, timestamp: new Date().toISOString() }, null, 2));
                fs.unlinkSync(filePath);
            } catch (e2) {}
            this.isProcessing = false;
        }
    };

    MCPPremiereBridge.prototype.executeCommand = function(command, done) {
        var self = this;
        this.updateCommandStatus(command.id, 'executing');
        if (!this.validateScript(command.script)) {
            done({ success: false, error: 'Script validation failed' });
            return;
        }
        this.executeExtendScript(command.script, function(err, result) {
            if (err) {
                done({ success: false, error: err.message });
                return;
            }
            done({ success: true, result: result, timestamp: new Date().toISOString() });
        });
    };

    MCPPremiereBridge.prototype.executeExtendScript = function(script, callback) {
        var self = this;
        try {
            if (!this.csInterface) {
                callback(new Error('CSInterface not initialized'));
                return;
            }

            // Get host environment info for debugging
            var hostEnv = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            if (!hostEnv) {
                callback(new Error('Could not get host environment. Is Premiere Pro running?'));
                return;
            }

            var fullScript = EXTENDSCRIPT_COMPAT_HELPERS + '\n' + script;
            var settled = false;
            var timeoutMs = 45000;
            var timeoutId = setTimeout(function() {
                if (settled) return;
                settled = true;
                callback(new Error(
                    'ExtendScript execution timed out after ' + timeoutMs + 'ms. ' +
                    'Premiere Pro or the CEP scripting host did not return a result.'
                ));
            }, timeoutMs);

            this.csInterface.evalScript(fullScript, function(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                self.log('EvalScript result: ' + result, 'info');

                if (result === 'EvalScript error.' || result === 'EvalScript error') {
                    callback(new Error(
                        'ExtendScript execution failed via CEP evalScript(). ' +
                        'This is usually a host-side scripting failure or CEP compatibility issue, not a JSON parsing problem.'
                    ));
                    return;
                }

                if (typeof result === 'string' && result.indexOf('Error') === 0) {
                    callback(new Error(result));
                    return;
                }

                try {
                    var parsed = JSON.parse(result);
                    callback(null, parsed);
                } catch (e) {
                    callback(null, result);
                }
            });
        } catch (e) {
            callback(e);
        }
    };

    MCPPremiereBridge.prototype.validateScript = function(script) {
        if (!script || typeof script !== 'string') return false;
        var dangerous = [
            /eval\s*\(/i,
            /\bnew\s+Function\s*\(/i,
            /\brequire\s*\(/i,
            /\b__dirname\b/i,
            /\b__filename\b/i,
            /\bprocess\./i,
            /\bchild_process\b/i
        ];
        for (var i = 0; i < dangerous.length; i++) {
            if (dangerous[i].test(script)) return false;
        }
        return script.length <= 500000;
    };

    MCPPremiereBridge.prototype.startCommandPolling = function() {
        var self = this;
        setInterval(function() {
            if (!self.isProcessing && self.isConnected) {
                var tempPath = self.getTempDirectory();
                if (tempPath) self.watchDirectory(tempPath);
            }
        }, 250);
    };

    MCPPremiereBridge.prototype.addToQueue = function(command) {
        this.commandQueue.push({ id: command.id, status: 'pending', script: (command.script || '').substring(0, 50) + '...' });
        this.updateCommandQueueUI();
    };

    MCPPremiereBridge.prototype.updateCommandStatus = function(commandId, status) {
        for (var i = 0; i < this.commandQueue.length; i++) {
            if (this.commandQueue[i].id === commandId) {
                this.commandQueue[i].status = status;
                break;
            }
        }
        this.updateCommandQueueUI();
    };

    MCPPremiereBridge.prototype.updateCommandQueueUI = function() {
        var el = document.getElementById('commandQueue');
        if (!el) return;
        if (this.commandQueue.length === 0) {
            el.innerHTML = '<div class="command-item"><span class="command-label">No commands in queue</span></div>';
            return;
        }
        var html = this.commandQueue.slice(-5).map(function(cmd) {
            return '<div class="command-item"><span class="command-label">' + cmd.script + '</span><span class="command-status ' + cmd.status + '">' + cmd.status + '</span></div>';
        }).join('');
        el.innerHTML = html;
    };

    MCPPremiereBridge.prototype.loadConfig = function() {
        try {
            var panelConfigPath = getPanelConfigPath();
            if (fs.existsSync(panelConfigPath)) {
                var panelConfig = JSON.parse(fs.readFileSync(panelConfigPath, 'utf8'));
                if (panelConfig.tempDirectory) {
                    this.tempDirectory = sanitizeTempDirectoryInput(panelConfig.tempDirectory);
                }
            }

            var candidatePaths = this.tempDirectory ? [this.tempDirectory, getDefaultTempPath()] : [getDefaultTempPath()];
            if (process.env.PREMIERE_TEMP_DIR) {
                candidatePaths.push(sanitizeTempDirectoryInput(process.env.PREMIERE_TEMP_DIR));
            }

            for (var i = 0; !this.tempDirectory && i < candidatePaths.length; i++) {
                var candidatePath = sanitizeTempDirectoryInput(candidatePaths[i]);
                if (!candidatePath || !fs.existsSync(candidatePath)) continue;
                var configPath = path.join(candidatePath, 'config.json');
                if (fs.existsSync(configPath)) {
                    var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    if (config.tempDirectory) {
                        this.tempDirectory = sanitizeTempDirectoryInput(config.tempDirectory);
                        break;
                    }
                }
            }

            var tempEl = document.getElementById('tempDirectory');
            if (tempEl) {
                var fieldValue = sanitizeTempDirectoryInput(tempEl.value);
                if (!this.tempDirectory && fieldValue) this.tempDirectory = fieldValue;
                if (this.tempDirectory) {
                    tempEl.value = this.tempDirectory;
                } else {
                    tempEl.value = getDefaultTempPath();
                }
            }
        } catch (e) {}
    };

    MCPPremiereBridge.prototype.saveConfig = function() {
        try {
            var tempEl = document.getElementById('tempDirectory');
            var tempDir = tempEl ? sanitizeTempDirectoryInput(tempEl.value) : '';
            if (tempDir) this.tempDirectory = tempDir;
            var ensuredTempDir = this.getTempDirectory();
            if (!ensuredTempDir) {
                throw new Error('Could not create or access temp directory');
            }
            if (tempEl) tempEl.value = this.tempDirectory;
            fs.writeFileSync(path.join(ensuredTempDir, 'config.json'), JSON.stringify({ tempDirectory: this.tempDirectory }, null, 2));
            fs.writeFileSync(getPanelConfigPath(), JSON.stringify({ tempDirectory: this.tempDirectory }, null, 2));
            this.log('Configuration saved', 'info');
        } catch (e) {
            this.log('Error saving config: ' + e.message, 'error');
        }
    };

    MCPPremiereBridge.prototype.startBridge = function() {
        this.log('Starting MCP Bridge...', 'info');
        this.isProcessing = false;
        this.isConnected = true;
        this.updateUI();
        var tempPath = this.getTempDirectory();
        if (!tempPath) {
            this.isConnected = false;
            this.updateUI();
            this.updateServerStatus(false);
            return;
        }
        this.log('Watching: ' + tempPath + ' (must match your MCP client PREMIERE_TEMP_DIR)', 'info');
        this.updateServerStatus(true);
        this.log('Bridge ready. Connect from Codex, Claude, or another MCP client using this same temp directory.', 'info');
    };

    MCPPremiereBridge.prototype.stopBridge = function() {
        this.log('Stopping MCP Bridge...', 'info');
        this.isConnected = false;
        this.isProcessing = false;
        this.updateUI();
        this.updateServerStatus(false);
    };

    MCPPremiereBridge.prototype.runDiagnostics = function() {
        var self = this;
        var hostEnvironment = null;
        var report = {
            generatedAt: new Date().toISOString(),
            panel: 'MCP Bridge (CEP)',
            tempDirectory: this.getTempDirectory(),
            hostEnvironment: null,
            checks: []
        };

        function addCheck(name, success, details) {
            report.checks.push({
                name: name,
                success: success,
                details: details
            });
        }

        function finalize() {
            var reportPath = self.writeDiagnosticReport(report);
            if (reportPath) {
                self.log('Diagnostics report saved to ' + reportPath, 'info');
            }
            self.log('Diagnostics summary: ' + JSON.stringify(report), 'info');
        }

        this.log('Running CEP diagnostics...', 'info');

        try {
            hostEnvironment = this.normalizeHostEnvironment(this.csInterface.getHostEnvironment());
            report.hostEnvironment = hostEnvironment;
            addCheck('host_environment', !!hostEnvironment, hostEnvironment || 'No host environment returned');
        } catch (e) {
            addCheck('host_environment', false, e.message);
            finalize();
            return;
        }

        var checks = [
            {
                name: 'eval_string',
                script: '(function(){ return "cep-ok"; })();'
            },
            {
                name: 'app_version_raw',
                script: '(function(){ try { return app.version; } catch (e) { return "ERROR: " + String(e); } })();'
            },
            {
                name: 'eval_json_roundtrip',
                script: '(function(){ return JSON.stringify({ ok: true, transport: "cep" }); })();'
            },
            {
                name: 'app_version',
                script: '(function(){ try { return JSON.stringify({ appVersion: app.version, appName: app.name }); } catch (e) { return JSON.stringify({ error: String(e) }); } })();'
            },
            {
                name: 'project_access',
                script: '(function(){ try { return JSON.stringify({ projectName: (app.project && app.project.name) ? app.project.name : "No project open" }); } catch (e) { return JSON.stringify({ error: String(e) }); } })();'
            }
        ];

        function runCheck(index) {
            if (index >= checks.length) {
                finalize();
                return;
            }

            var check = checks[index];
            self.executeExtendScript(check.script, function(err, result) {
                if (err) {
                    addCheck(check.name, false, err.message);
                } else {
                    addCheck(check.name, true, result);
                }
                runCheck(index + 1);
            });
        }

        runCheck(0);
    };

    MCPPremiereBridge.prototype.testPremiereConnection = function() {
        var self = this;
        var script = '(function() {\
            try {\
                var d = new Date();\
                var timestamp = d.getFullYear() + "-" + \
                    String(d.getMonth() + 1).replace(/^(\\d)$/, "0$1") + "-" + \
                    String(d.getDate()).replace(/^(\\d)$/, "0$1") + "T" + \
                    String(d.getHours()).replace(/^(\\d)$/, "0$1") + ":" + \
                    String(d.getMinutes()).replace(/^(\\d)$/, "0$1") + ":" + \
                    String(d.getSeconds()).replace(/^(\\d)$/, "0$1");\
                var info = {\
                    appVersion: app.version,\
                    projectName: "No project open",\
                    timestamp: timestamp\
                };\
                try {\
                    if (app.project && app.project.name) {\
                        info.projectName = app.project.name;\
                    }\
                } catch(e) {}\
                return JSON.stringify(info);\
            } catch(e) {\
                return JSON.stringify({ error: String(e) });\
            }\
        })();';
        this.executeExtendScript(script, function(err, result) {
            if (err) {
                self.log('Premiere Pro connection failed: ' + err.message, 'error');
                self.updateServerStatus(false);
            } else {
                self.log('Premiere Pro connection OK: ' + JSON.stringify(result), 'info');
                self.updateServerStatus(true);
            }
        });
    };

    MCPPremiereBridge.prototype.updateUI = function() {
        var connectionStatus = document.getElementById('connectionStatus');
        var connectionText = document.getElementById('connectionText');
        if (connectionStatus && connectionText) {
            if (this.isConnected) {
                connectionStatus.className = 'status-dot connected';
                connectionText.textContent = 'Connected';
            } else {
                connectionStatus.className = 'status-dot disconnected';
                connectionText.textContent = 'Disconnected';
            }
        }
        var startBtn = document.getElementById('startButton');
        var stopBtn = document.getElementById('stopButton');
        if (startBtn) startBtn.disabled = this.isConnected;
        if (stopBtn) stopBtn.disabled = !this.isConnected;
        var tempEl = document.getElementById('tempDirectory');
        if (tempEl && !tempEl.value && this.getTempDirectory()) tempEl.value = this.getTempDirectory();
    };

    MCPPremiereBridge.prototype.updateServerStatus = function(isRunning) {
        var serverStatus = document.getElementById('serverStatus');
        var serverText = document.getElementById('serverText');
        if (serverStatus && serverText) {
            if (isRunning) {
                serverStatus.className = 'status-dot connected';
                serverText.textContent = 'Premiere Pro: Ready';
            } else {
                serverStatus.className = 'status-dot disconnected';
                serverText.textContent = 'Premiere Pro: Start Bridge to enable';
            }
        }
    };

    MCPPremiereBridge.prototype.log = function(message, level) {
        level = level || 'info';
        var logContainer = document.getElementById('logContainer');
        if (logContainer) {
            var el = document.createElement('div');
            el.className = 'log-entry ' + level;
            el.textContent = '[' + new Date().toISOString() + '] ' + message;
            logContainer.appendChild(el);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        console.log(message);
    };

    MCPPremiereBridge.prototype.runBaseEditing = function(onDuplicate) {
        var self = this;
        var presetInput = document.getElementById('bePresetPath');
        var presetPath = presetInput ? (presetInput.value || '') : '';
        var fadeInput = document.getElementById('beFadeDuration');
        var fadeDuration = fadeInput && fadeInput.value ? parseFloat(fadeInput.value) : 0.04;
        if (!(fadeDuration > 0)) fadeDuration = 0.04;
        var scaleInput = document.getElementById('beScalePercent');
        var scalePercent = scaleInput && scaleInput.value ? parseFloat(scaleInput.value) : 130;
        if (!(scalePercent > 0)) scalePercent = 130;
        var posYInput = document.getElementById('bePosY');
        var positionYpx = posYInput && posYInput.value ? parseFloat(posYInput.value) : 613;
        var frameH = 1080;
        var positionYnorm = positionYpx / frameH;
        var positionXnorm = 0.5;
        var audioTransitionName = 'Custom Fade';
        var sourceVT = 0;
        var targetVT = 1;
        var zoomStart = 1; /* odd */
        var labelIndex = 1; /* Iris */
        var duplicateFirst = !!onDuplicate;

        var btn = document.getElementById('baseEditingButton');
        var btnDup = document.getElementById('baseEditingDupButton');
        if (btn) btn.disabled = true;
        if (btnDup) btnDup.disabled = true;
        self.log('Base Editing started (preset: ' + (presetPath || 'none') + ', duplicate: ' + duplicateFirst + ')', 'info');

        var script = ''
            + '(function() {'
            + 'try {'
            + '  app.enableQE();'
            + '  var sequence = app.project.activeSequence;'
            + '  if (!sequence) return JSON.stringify({ success: false, error: "No active sequence" });'
            + '  if (' + (duplicateFirst ? 'true' : 'false') + ') {'
            + '    try {'
            + '      var origName = sequence.name;'
            + '      var dupName = origName + "_BaseEdit";'
            + '      var qeOrig = qe.project.getActiveSequence();'
            + '      if (qeOrig && typeof qeOrig.duplicate === "function") {'
            + '        qeOrig.duplicate();'
            + '        var newSeq = null;'
            + '        for (var sx = 0; sx < app.project.sequences.numSequences; sx++) {'
            + '          var ss = app.project.sequences[sx];'
            + '          if (ss.name === origName + " Copy" || ss.name === origName + " copy" || ss.name.indexOf(origName) === 0 && ss.sequenceID !== sequence.sequenceID) {'
            + '            newSeq = ss;'
            + '          }'
            + '        }'
            + '        if (newSeq) {'
            + '          try { newSeq.name = dupName; } catch (eR) {}'
            + '          app.project.openSequence(newSeq.sequenceID);'
            + '          sequence = app.project.activeSequence;'
            + '        }'
            + '      }'
            + '    } catch (eDup) { /* fall back to original */ }'
            + '  }'
            + '  var qeSeq = qe.project.getActiveSequence();'
            + '  var fps = sequence.timebase ? (254016000000 / parseInt(sequence.timebase, 10)) : 30;'
            + '  var fadeFrames = Math.max(1, Math.round(' + fadeDuration + ' * fps));'
            + '  var report = { sequenceName: sequence.name, audioTracksTouched: 0, audioTransitionsAdded: 0, audioErrors: [], presetApplied: 0, presetSkipped: 0, presetErrors: [], zoomDupsCreated: 0, zoomErrors: [] };'
            + '  var audioTrans = null;'
            + '  try { audioTrans = qe.project.getAudioTransitionByName(' + JSON.stringify(audioTransitionName) + '); } catch (eT) {}'
            + '  if (!audioTrans) { try { audioTrans = qe.project.getAudioTransitionByName("Constant Power"); } catch (eT2) {} }'
            + '  if (audioTrans) {'
            + '    for (var ai = 0; ai < sequence.audioTracks.numTracks; ai++) {'
            + '      var aTrack = sequence.audioTracks[ai];'
            + '      if (aTrack.clips.numItems < 2) continue;'
            + '      var qeATrack = qeSeq.getAudioTrackAt(ai);'
            + '      var trackAdded = 0;'
            + '      for (var ac = 0; ac < aTrack.clips.numItems; ac++) {'
            + '        try {'
            + '          var qeAClip = qeATrack.getItemAt(ac);'
            + '          qeAClip.addTransition(audioTrans, true, fadeFrames + ":00", "0:00", 0.5, false, true);'
            + '          trackAdded++;'
            + '        } catch (eAC) { report.audioErrors.push("track " + ai + " clip " + ac + ": " + eAC.toString()); }'
            + '      }'
            + '      if (trackAdded > 0) { report.audioTracksTouched++; report.audioTransitionsAdded += trackAdded; }'
            + '    }'
            + '  } else { report.audioErrors.push("Audio transition not found"); }'
            + '  var presetPath = ' + JSON.stringify(presetPath) + ';'
            + '  var presetFile = null;'
            + '  if (presetPath) {'
            + '    try { var pf = new File(presetPath); if (pf.exists) presetFile = pf; else report.presetErrors.push("Preset not found at: " + presetPath); } catch (eF) { report.presetErrors.push("File ctor: " + eF.toString()); }'
            + '  }'
            + '  if (presetFile) {'
            + '    /* Detect supported preset method ONCE — audio TrackItem in PPro 2026 has no applyPreset */'
            + '    var presetMethod = null;'
            + '    var firstClip = null;'
            + '    for (var probeT = 0; probeT < sequence.audioTracks.numTracks && !firstClip; probeT++) {'
            + '      if (sequence.audioTracks[probeT].clips.numItems > 0) firstClip = sequence.audioTracks[probeT].clips[0];'
            + '    }'
            + '    if (firstClip) {'
            + '      if (typeof firstClip.applyPreset === "function") presetMethod = "trackItem";'
            + '      else {'
            + '        try { var qeProbe = qeSeq.getAudioTrackAt(0).getItemAt(0); if (qeProbe && typeof qeProbe.applyPreset === "function") presetMethod = "qe"; } catch (eQP) {}'
            + '      }'
            + '    }'
            + '    if (!presetMethod) {'
            + '      report.presetErrors.push("AudioClipTrackItem.applyPreset is not a function in this Premiere version. Apply Audio Refiner manually: select audio clips → right-click → Apply Preset → Audio Refiner.");'
            + '    } else {'
            + '      for (var apT = 0; apT < sequence.audioTracks.numTracks; apT++) {'
            + '        var apTrack = sequence.audioTracks[apT];'
            + '        if (apTrack.clips.numItems === 0) continue;'
            + '        var qeApTrack = null; try { qeApTrack = qeSeq.getAudioTrackAt(apT); } catch (eQT) {}'
            + '        for (var apC = 0; apC < apTrack.clips.numItems; apC++) {'
            + '          try {'
            + '            var apClip = apTrack.clips[apC];'
            + '            var ok = false;'
            + '            if (presetMethod === "trackItem") { ok = apClip.applyPreset(presetFile); }'
            + '            else if (presetMethod === "qe" && qeApTrack) { try { var qeAC = qeApTrack.getItemAt(apC); ok = qeAC.applyPreset(presetFile); } catch (eQAC) { ok = false; } }'
            + '            if (ok === false) { report.presetErrors.push("track " + apT + " clip " + apC + " via " + presetMethod + ": returned false"); report.presetSkipped++; }'
            + '            else { report.presetApplied++; }'
            + '          } catch (ePA) { report.presetErrors.push("track " + apT + " clip " + apC + ": " + ePA.toString()); report.presetSkipped++; }'
            + '        }'
            + '      }'
            + '    }'
            + '    report.presetMethod = presetMethod;'
            + '  }'
            + '  var srcTrack = sequence.videoTracks[' + sourceVT + '];'
            + '  var tgtTrack = sequence.videoTracks[' + targetVT + '];'
            + '  if (srcTrack && tgtTrack) {'
            + '    /* Disable targeting on ALL audio tracks (best-effort) and snapshot pre-existing audio clips for cleanup */'
            + '    var savedAudioTargets = [];'
            + '    for (var atI = 0; atI < sequence.audioTracks.numTracks; atI++) {'
            + '      try { savedAudioTargets.push(sequence.audioTracks[atI].isTargeted()); sequence.audioTracks[atI].setTargeted(false, true); } catch (eAT) { savedAudioTargets.push(null); }'
            + '    }'
            + '    var preAudioKeys = {};'
            + '    for (var paT = 0; paT < sequence.audioTracks.numTracks; paT++) {'
            + '      preAudioKeys[paT] = {};'
            + '      var paTrack = sequence.audioTracks[paT];'
            + '      for (var paC = 0; paC < paTrack.clips.numItems; paC++) {'
            + '        try { var paClip = paTrack.clips[paC]; preAudioKeys[paT][Math.round(paClip.start.seconds * 1000) + "_" + Math.round(paClip.end.seconds * 1000)] = true; } catch (ePA) {}'
            + '      }'
            + '    }'
            + '    var snapshots = [];'
            + '    for (var vi = 0; vi < srcTrack.clips.numItems; vi++) {'
            + '      var sc = srcTrack.clips[vi];'
            + '      snapshots.push({ index: vi, start: sc.start.seconds, end: sc.end.seconds, inPoint: sc.inPoint.seconds, outPoint: sc.outPoint.seconds, projItem: sc.projectItem || null });'
            + '    }'
            + '    for (var si = 0; si < snapshots.length; si++) {'
            + '      if ((si % 2) !== ' + zoomStart + ') continue;'
            + '      var snap = snapshots[si];'
            + '      if (!snap.projItem) continue;'
            + '      try {'
            + '        tgtTrack.overwriteClip(snap.projItem, snap.start);'
            + '        var newClip = null;'
            + '        for (var tc = 0; tc < tgtTrack.clips.numItems; tc++) {'
            + '          var cand = tgtTrack.clips[tc];'
            + '          if (Math.abs(cand.start.seconds - snap.start) < 0.005) { newClip = cand; break; }'
            + '        }'
            + '        if (!newClip) { report.zoomErrors.push("idx " + si + ": insert lookup failed"); continue; }'
            + '        try { var ip = new Time(); ip.seconds = snap.inPoint; newClip.inPoint = ip; } catch (e1) {}'
            + '        try { var op = new Time(); op.seconds = snap.outPoint; newClip.outPoint = op; } catch (e2) {}'
            + '        try { var en = new Time(); en.seconds = snap.end; newClip.end = en; } catch (e3) {}'
            + '        var motion = null;'
            + '        try { for (var comp = 0; comp < newClip.components.numItems; comp++) { var cc = newClip.components[comp]; var dn = ""; try { dn = cc.displayName; } catch (eD) {} if (dn === "Motion") { motion = cc; break; } } } catch (eM) {}'
            + '        if (motion && motion.properties && motion.properties.numItems > 0) {'
            + '          var pPos = null, pScale = null, pUniform = null;'
            + '          for (var pi = 0; pi < motion.properties.numItems; pi++) {'
            + '            try { var prp = motion.properties[pi]; var pdn = ""; try { pdn = prp.displayName; } catch (ePD) {}'
            + '              if (pdn === "Position") pPos = prp;'
            + '              else if (pdn === "Scale") pScale = prp;'
            + '              else if (pdn === "Uniform Scale") pUniform = prp;'
            + '            } catch (ePI) {}'
            + '          }'
            + '          if (!pPos) { try { pPos = motion.properties[0]; } catch (eF1) {} }'
            + '          if (!pScale) { try { pScale = motion.properties[1]; } catch (eF2) {} }'
            + '          try { if (pUniform) pUniform.setValue(true, true); } catch (eU) {}'
            + '          try { if (pScale) pScale.setValue(' + scalePercent + ', true); } catch (eS) {}'
            + '          try { if (pPos) pPos.setValue([' + positionXnorm + ', ' + positionYnorm + '], true); } catch (eP) {}'
            + '        }'
            + '        try { newClip.setColorLabel(' + labelIndex + '); } catch (eL1) { try { newClip.label = ' + labelIndex + '; } catch (eL2) { report.zoomErrors.push("idx " + si + " label: " + eL1.toString() + " / " + eL2.toString()); } }'
            + '        report.zoomDupsCreated++;'
            + '      } catch (eDupC) { report.zoomErrors.push("idx " + si + ": " + eDupC.toString()); }'
            + '    }'
            + '    /* Cleanup: remove any new audio clips that appeared during V2 dup (Premiere inserts linked AV despite targeting=false) */'
            + '    var strayAudio = 0;'
            + '    for (var cuT = 0; cuT < sequence.audioTracks.numTracks; cuT++) {'
            + '      var cuTrack = sequence.audioTracks[cuT];'
            + '      var toRemove = [];'
            + '      for (var cuC = 0; cuC < cuTrack.clips.numItems; cuC++) {'
            + '        try {'
            + '          var cuClip = cuTrack.clips[cuC];'
            + '          var key = Math.round(cuClip.start.seconds * 1000) + "_" + Math.round(cuClip.end.seconds * 1000);'
            + '          if (!(preAudioKeys[cuT] && preAudioKeys[cuT][key])) toRemove.push(cuClip);'
            + '        } catch (eCU) {}'
            + '      }'
            + '      for (var rmI = toRemove.length - 1; rmI >= 0; rmI--) {'
            + '        try { toRemove[rmI].remove(false, false); strayAudio++; } catch (eRm) {}'
            + '      }'
            + '    }'
            + '    report.strayAudioRemoved = strayAudio;'
            + '    /* restore audio targeting */'
            + '    for (var atR = 0; atR < savedAudioTargets.length && atR < sequence.audioTracks.numTracks; atR++) {'
            + '      try { if (savedAudioTargets[atR] !== null) sequence.audioTracks[atR].setTargeted(!!savedAudioTargets[atR], true); } catch (eAR) {}'
            + '    }'
            + '  }'
            + '  return JSON.stringify({ success: true, fps: fps, fadeFrames: fadeFrames, report: report });'
            + '} catch (eAll) { return JSON.stringify({ success: false, error: eAll.toString() }); }'
            + '})();';

        this.executeExtendScript(script, function(err, result) {
            if (btn) btn.disabled = false;
            if (btnDup) btnDup.disabled = false;
            if (err) { self.log('Base Editing FAILED: ' + err.message, 'error'); return; }
            if (!result || result.success === false) {
                self.log('Base Editing error: ' + (result && result.error ? result.error : 'unknown'), 'error');
                return;
            }
            var r = result.report || {};
            self.log('Base Editing OK on "' + (r.sequenceName || '?') + '" — fades: ' + (r.audioTransitionsAdded || 0) + ' on ' + (r.audioTracksTouched || 0) + ' tracks; preset applied: ' + (r.presetApplied || 0) + (r.presetSkipped ? ' (' + r.presetSkipped + ' skipped)' : '') + '; zoom dups: ' + (r.zoomDupsCreated || 0), 'info');
            if (r.audioErrors && r.audioErrors.length) self.log('Audio errors (' + r.audioErrors.length + '): ' + r.audioErrors.slice(0,3).join(' | '), 'warning');
            if (r.presetErrors && r.presetErrors.length) self.log('Preset errors (' + r.presetErrors.length + '): ' + r.presetErrors.slice(0,3).join(' | '), 'warning');
            if (r.zoomErrors && r.zoomErrors.length) self.log('Zoom errors (' + r.zoomErrors.length + '): ' + r.zoomErrors.slice(0,3).join(' | '), 'warning');
        });
    };

    MCPPremiereBridge.prototype.clearLog = function() {
        var logContainer = document.getElementById('logContainer');
        if (logContainer) logContainer.innerHTML = '<div class="log-entry info">Log cleared</div>';
    };

    window.MCPPremiereBridge = MCPPremiereBridge;
    window.bridge = null;
    window.startBridge = function() { if (window.bridge) window.bridge.startBridge(); };
    window.stopBridge = function() { if (window.bridge) window.bridge.stopBridge(); };
    window.runDiagnostics = function() { if (window.bridge) window.bridge.runDiagnostics(); };
    window.saveConfig = function() { if (window.bridge) window.bridge.saveConfig(); };
    window.clearLog = function() { if (window.bridge) window.bridge.clearLog(); };
    window.runBaseEditing = function(onDuplicate) { if (window.bridge) window.bridge.runBaseEditing(onDuplicate); };
    document.addEventListener('DOMContentLoaded', function() {
        window.bridge = new MCPPremiereBridge();
    });
})();
