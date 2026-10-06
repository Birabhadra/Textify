(function () {
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    const ADD_CUSTOM = '__add_custom__';
    const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1';
    const FORMAT_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local' };
    const controls = Array.from(document.querySelectorAll('[data-key]'));
    const providerSelect = $('provider');
    const modelOptions = $('model-options');
    const keyProvider = $('key-provider');
    const keyValue = $('key-value');
    const form = $('custom-form');

    let providers = [];
    let config = {};
    let applyingRemote = false;
    let nextRequestId = 1;
    // Provider to select in the key dropdown once the refreshed provider list arrives.
    let preferredKeyProvider = null;
    let usage = null;
    let usagePeriod = 'session';
    let editingPriceKey = null;
    const SOURCE_LABELS = {
        custom: 'your price',
        list: 'list price',
        local: 'local · free',
        catalog: '≈ catalog',
        provider: 'reported by provider'
    };
    const pending = new Map();

    // ---------------------------------------------------------------- helpers

    function request(message, onReply) {
        const requestId = nextRequestId++;
        pending.set(requestId, onReply);
        vscode.postMessage({ ...message, requestId });
    }

    function setStatus(el, text, kind) {
        el.textContent = text || '';
        el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function setBusy(button, busy, label) {
        if (busy) {
            button.dataset.label = button.textContent;
            button.textContent = label;
            button.disabled = true;
        } else {
            button.textContent = button.dataset.label || button.textContent;
            button.disabled = false;
        }
    }

    function describeRun(result) {
        const run = result.runs[0];
        if (!run) { return 'No result'; }
        if (!run.ok) { return 'Failed: ' + run.error; }
        return `OK: ${result.model} · first token ${run.ttftMs} ms · total ${run.totalMs} ms`;
    }

    function setControlValue(control, value) {
        if (control.dataset.type === 'boolean') {
            control.checked = Boolean(value);
        } else {
            control.value = value ?? '';
        }
    }

    function readControlValue(control) {
        if (control.dataset.type === 'boolean') {
            return control.checked;
        }
        if (control.dataset.type === 'number') {
            return Number(control.value);
        }
        return control.value;
    }

    // ---------------------------------------------------------------- rendering

    function applyConfig(next) {
        config = next;
        applyingRemote = true;
        for (const control of controls) {
            const key = control.dataset.key;
            // Don't clobber a textarea the user is typing in.
            if (key in config && document.activeElement !== control) {
                setControlValue(control, config[key]);
            }
        }
        applyingRemote = false;
        updateModelOptions();
        renderKeyField();
    }

    function selectedProvider() {
        return providers.find((p) => p.id === providerSelect.value);
    }

    function updateModelOptions() {
        const provider = selectedProvider();
        modelOptions.innerHTML = '';
        for (const model of provider ? provider.models : []) {
            const option = document.createElement('option');
            option.value = model;
            modelOptions.appendChild(option);
        }
    }

    function fillSelect(select, items, keepValue) {
        const previous = keepValue ?? select.value;
        select.innerHTML = '';
        for (const item of items) {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            select.appendChild(option);
        }
        if (items.some((i) => i.value === previous)) {
            select.value = previous;
        }
    }

    function applyProviders(message) {
        providers = message.providers;
        const providerItems = [{ value: 'auto', label: 'Auto (first configured key)' }]
            .concat(providers.map((p) => ({ value: p.id, label: p.label + (p.isCustom ? ' (custom)' : '') + (p.hasKey || p.isCustom ? '' : ' - no key') })))
            .concat([{ value: ADD_CUSTOM, label: '+ Add custom provider…' }]);
        applyingRemote = true;
        fillSelect(providerSelect, providerItems, config.provider);
        applyingRemote = false;

        fillSelect(keyProvider, providers.map((p) => ({
            value: p.id,
            label: `${p.label}${p.isCustom ? ' (custom)' : ''} ${p.hasKey ? '✓' : ''}`.trim()
        })), preferredKeyProvider || keyProvider.value || message.activeProviderId || undefined);
        if (preferredKeyProvider && keyProvider.value === preferredKeyProvider) {
            preferredKeyProvider = null;
        }

        $('active-provider').textContent = message.activeProviderId
            ? `Using ${providers.find((p) => p.id === message.activeProviderId)?.label ?? message.activeProviderId} · ${message.activeModel}`
            : 'No provider configured yet: add an API key below.';

        updateModelOptions();
        renderKeyField();
        renderCustomList();
    }

    function renderKeyField() {
        const provider = providers.find((p) => p.id === keyProvider.value);
        if (!provider) { return; }
        $('key-label').textContent = `${provider.label} API key`;
        if (document.activeElement !== keyValue) {
            keyValue.value = provider.custom ? (provider.custom.apiKey || '') : (config[`${provider.id}ApiKey`] || '');
        }
        $('key-hint').textContent = provider.hasKey ? 'Key saved.' : (provider.isCustom ? 'Optional for local servers.' : 'Not set.');
    }

    function renderCustomList() {
        const list = $('custom-list');
        list.innerHTML = '';
        const customs = providers.filter((p) => p.isCustom);
        if (customs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'description';
            empty.textContent = 'Add any OpenAI- or Anthropic-compatible endpoint (Together, DeepSeek, Ollama, LM Studio, a company proxy…).';
            list.appendChild(empty);
            return;
        }
        for (const provider of customs) {
            const item = document.createElement('div');
            item.className = 'custom-item';
            const text = document.createElement('div');
            text.className = 'custom-text';
            const title = document.createElement('div');
            title.textContent = provider.label;
            const meta = document.createElement('div');
            meta.className = 'description';
            meta.textContent = `${FORMAT_LABELS[provider.format] || 'OpenAI'} · ${provider.custom.baseUrl}`;
            text.append(title, meta);

            const edit = document.createElement('button');
            edit.className = 'secondary small';
            edit.textContent = 'Edit';
            edit.addEventListener('click', () => openForm(provider.custom));
            const remove = document.createElement('button');
            remove.className = 'secondary small';
            remove.textContent = 'Remove';
            remove.addEventListener('click', () => vscode.postMessage({ type: 'deleteCustomProvider', providerId: provider.id }));
            item.append(text, edit, remove);
            list.appendChild(item);
        }
    }

    function renderLatency(stats) {
        const el = $('latency-stats');
        if (!stats || stats.count === 0) {
            el.textContent = 'No completions measured yet.';
            return;
        }
        el.textContent = `Last ${stats.count} completions · p50 first token ${stats.ttft.p50} ms · p50 total ${stats.total.p50} ms ` +
            `(p90 ${stats.total.p90} ms) · context ${stats.context.p50} ms`;
    }

    // ---------------------------------------------------------------- usage

    function formatTokens(n) {
        if (n >= 1e6) { return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm'; }
        if (n >= 1e3) { return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; }
        return String(Math.round(n));
    }

    function formatCost(usd) {
        return usd > 0 && usd < 0.01 ? '$' + usd.toFixed(4) : '$' + usd.toFixed(2);
    }

    function formatDuration(ms) {
        const total = Math.max(0, ms) / 1000;
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = (total % 60).toFixed(1);
        return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
    }

    function metric(label, value, detail) {
        const cell = document.createElement('div');
        cell.className = 'metric';
        const v = document.createElement('div');
        v.className = 'metric-value';
        v.textContent = value;
        const l = document.createElement('div');
        l.className = 'metric-label';
        l.textContent = label;
        cell.append(v, l);
        if (detail) {
            const d = document.createElement('div');
            d.className = 'metric-detail';
            d.textContent = detail;
            cell.appendChild(d);
        }
        return cell;
    }

    function renderUsage() {
        const grid = $('usage-metrics');
        const table = $('usage-models');
        grid.innerHTML = '';
        table.innerHTML = '';
        $('usage-session').classList.toggle('active', usagePeriod === 'session');
        $('usage-lifetime').classList.toggle('active', usagePeriod === 'lifetime');
        $('usage-session').setAttribute('aria-selected', String(usagePeriod === 'session'));
        $('usage-lifetime').setAttribute('aria-selected', String(usagePeriod === 'lifetime'));
        if (!usage) {
            return;
        }
        const t = usage[usagePeriod];
        const models = Object.entries(t.byModel).sort((a, b) => b[1].requests - a[1].requests);
        const labels = usage.providerLabels || {};
        const displayName = (m) => {
            const duplicated = models.filter(([, other]) => other.model === m.model).length > 1;
            return duplicated || String(m.provider).startsWith('custom:') ? `${m.model} (${labels[m.provider] || m.provider})` : m.model;
        };
        let cost = 0;
        let unpriced = 0;
        let tokens = 0;
        for (const [, m] of models) {
            cost += m.costUsd;
            unpriced += m.unpricedRequests;
            tokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
        }
        const rate = t.suggestionsShown > 0 ? Math.round((t.accepted / t.suggestionsShown) * 100) + '%' : '—';
        grid.append(
            metric('Cost', formatCost(cost), unpriced ? `+${unpriced} unpriced` : ''),
            metric('Tokens', formatTokens(tokens)),
            metric('Requests', String(t.apiRequests), `${t.cancelledRequests} cancelled · ${t.failedRequests} failed`),
            metric('Acceptance', rate, `${t.accepted} of ${t.suggestionsShown} shown`),
            metric('API time', formatDuration(t.apiDurationMs), 'wall ' + formatDuration((usage.now || Date.now()) - t.startedAt)),
            metric('Code changes', `+${t.linesAdded} −${t.linesRemoved}`, 'lines')
        );

        if (models.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'description';
            empty.textContent = 'No provider usage yet.';
            table.appendChild(empty);
            return;
        }
        for (const [, m] of models) {
            const row = document.createElement('div');
            row.className = 'usage-row';
            const title = document.createElement('div');
            title.className = 'usage-model';
            const nameEl = document.createElement('span');
            nameEl.textContent = displayName(m);
            nameEl.title = `${labels[m.provider] || m.provider} · ${m.model}`;
            const costEl = document.createElement('span');
            costEl.className = 'usage-cost';
            costEl.textContent = m.unpricedRequests === 0 ? formatCost(m.costUsd) : 'unpriced';
            if (m.priceSource) {
                costEl.title = SOURCE_LABELS[m.priceSource] || m.priceSource;
            }
            title.append(nameEl, costEl);
            const detail = document.createElement('div');
            detail.className = 'description';
            detail.textContent = `${formatTokens(m.inputTokens)} input · ${formatTokens(m.outputTokens)} output · ` +
                `${formatTokens(m.cacheReadTokens)} cache read · ${formatTokens(m.cacheWriteTokens)} cache write · ${m.requests} req`;
            row.append(title, detail);
            table.appendChild(row);
        }
    }

    // ---------------------------------------------------------------- model prices

    function priceText(price) {
        if (!price) { return 'No price'; }
        const parts = [`in $${price.input}`, `out $${price.output}`];
        if (price.cacheRead !== undefined) { parts.push(`cache read $${price.cacheRead}`); }
        return parts.join(' · ');
    }

    function numberInput(placeholder, value) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = 'any';
        input.placeholder = placeholder;
        input.value = value ?? '';
        input.setAttribute('aria-label', placeholder);
        return input;
    }

    function renderPricing() {
        const container = $('pricing-rows');
        container.innerHTML = '';
        const rows = usage?.pricing || [];
        const catalog = usage?.catalog;
        if (catalog) {
            $('pricing-refresh').disabled = false;
            const age = catalog.fetchedAt ? Math.round((Date.now() - catalog.fetchedAt) / 3600000) : null;
            setStatus($('pricing-status'), catalog.models
                ? `Catalog: ${catalog.models} models, updated ${age === 0 ? 'under an hour' : age + 'h'} ago${catalog.enabled ? '' : ' (auto-refresh off)'}.`
                : (catalog.enabled ? 'Catalog not loaded yet.' : 'Catalog auto-refresh is off (textify.fetchPricingCatalog).'));
        }
        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'description';
            empty.textContent = 'Models appear here once a provider is configured.';
            container.appendChild(empty);
            return;
        }
        for (const row of rows) {
            const key = row.provider + '|' + row.model;
            const item = document.createElement('div');
            item.className = 'price-row' + (row.price ? '' : ' unpriced');

            const head = document.createElement('div');
            head.className = 'price-head';
            const name = document.createElement('div');
            name.className = 'price-name';
            name.textContent = row.model;
            name.title = row.matchedId ? `Matched catalog entry: ${row.matchedId}` : row.model;
            const provider = document.createElement('div');
            provider.className = 'description';
            provider.textContent = row.providerLabel + (row.reportsCost ? ' · reports its own cost' : '');
            const text = document.createElement('div');
            text.className = 'description';
            text.textContent = priceText(row.price) + (row.source ? ` · ${SOURCE_LABELS[row.source] || row.source}` : '');
            const info = document.createElement('div');
            info.className = 'custom-text';
            info.append(name, provider, text);

            const edit = document.createElement('button');
            edit.className = 'secondary small';
            edit.textContent = row.price ? 'Edit' : 'Set price';
            edit.addEventListener('click', () => {
                editingPriceKey = editingPriceKey === key ? null : key;
                renderPricing();
            });
            head.append(info, edit);
            item.appendChild(head);

            if (editingPriceKey === key) {
                const form = document.createElement('form');
                form.className = 'price-form';
                const current = row.price;
                const input = numberInput('Input', current?.input);
                const output = numberInput('Output', current?.output);
                const cacheRead = numberInput('Cache read (opt.)', current?.cacheRead);
                const fields = document.createElement('div');
                fields.className = 'price-fields';
                fields.append(input, output, cacheRead);
                const actions = document.createElement('div');
                actions.className = 'actions';
                const save = document.createElement('button');
                save.type = 'submit';
                save.className = 'small';
                save.textContent = 'Save';
                actions.appendChild(save);
                if (row.source === 'custom') {
                    const clear = document.createElement('button');
                    clear.type = 'button';
                    clear.className = 'secondary small';
                    clear.textContent = 'Use default';
                    clear.addEventListener('click', () => {
                        vscode.postMessage({ type: 'setModelPrice', providerId: row.provider, model: row.model, price: null });
                        editingPriceKey = null;
                    });
                    actions.appendChild(clear);
                }
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'secondary small';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => { editingPriceKey = null; renderPricing(); });
                actions.appendChild(cancel);
                const error = document.createElement('div');
                error.className = 'status';
                form.append(fields, actions, error);
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    if (input.value === '' || output.value === '') {
                        setStatus(error, 'Enter input and output prices.', 'error');
                        return;
                    }
                    const price = { input: Number(input.value), output: Number(output.value) };
                    if (cacheRead.value !== '') { price.cacheRead = Number(cacheRead.value); }
                    vscode.postMessage({ type: 'setModelPrice', providerId: row.provider, model: row.model, price });
                    editingPriceKey = null;
                });
                item.appendChild(form);
            }
            container.appendChild(item);
        }
    }

    // ---------------------------------------------------------------- custom provider form

    function urlHint() {
        const format = $('custom-format').value;
        $('custom-url-hint').textContent = format === 'anthropic'
            ? 'e.g. https://my-proxy.example.com (…/v1/messages is added automatically)'
            : format === 'local'
                ? 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · llama.cpp: http://localhost:8080/v1'
                : 'e.g. https://api.together.xyz/v1 (…/chat/completions is added automatically)';
        $('detect-row').hidden = format === 'anthropic';
        if (format === 'local' && !$('custom-url').value.trim()) {
            $('custom-url').value = DEFAULT_LOCAL_URL;
        }
    }

    function openForm(custom) {
        form.hidden = false;
        $('custom-id').value = custom?.id ?? '';
        $('custom-name').value = custom?.name ?? '';
        $('custom-format').value = custom?.format ?? 'openai';
        $('custom-url').value = custom?.baseUrl ?? '';
        $('custom-key').value = custom?.apiKey ?? '';
        $('custom-models').value = (custom?.models ?? []).join(', ');
        setStatus($('custom-status'), '');
        urlHint();
        $('custom-name').focus();
    }

    function readForm() {
        return {
            id: $('custom-id').value || undefined,
            name: $('custom-name').value,
            format: $('custom-format').value,
            baseUrl: $('custom-url').value,
            apiKey: $('custom-key').value,
            models: $('custom-models').value.split(',').map((m) => m.trim()).filter(Boolean)
        };
    }

    // ---------------------------------------------------------------- events

    for (const control of controls) {
        control.addEventListener('change', () => {
            if (applyingRemote) {
                return;
            }
            const key = control.dataset.key;
            if (key === 'provider' && control.value === ADD_CUSTOM) {
                control.value = config.provider;
                openForm();
                return;
            }
            const value = readControlValue(control);
            if (key === 'provider') {
                updateModelOptions();
            }
            vscode.postMessage({ type: 'update', key, value });
        });
    }

    keyProvider.addEventListener('change', () => {
        keyValue.value = '';
        renderKeyField();
        setStatus($('key-status'), '');
    });

    $('key-save').addEventListener('click', () => {
        vscode.postMessage({ type: 'setApiKey', providerId: keyProvider.value, value: keyValue.value });
        setStatus($('key-status'), 'Saved.', 'ok');
    });
    keyValue.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { $('key-save').click(); }
    });

    $('key-test').addEventListener('click', () => {
        const button = $('key-test');
        // Save first so the test uses exactly what's in the box.
        vscode.postMessage({ type: 'setApiKey', providerId: keyProvider.value, value: keyValue.value });
        setBusy(button, true, 'Testing…');
        setStatus($('key-status'), 'Sending a test completion…');
        request({ type: 'testProvider', providerId: keyProvider.value, value: keyValue.value }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('key-status'), reply.message, 'error');
            } else {
                setStatus($('key-status'), describeRun(reply.result), reply.result.runs[0]?.ok ? 'ok' : 'error');
            }
        });
    });

    $('custom-add').addEventListener('click', () => openForm());
    $('local-add').addEventListener('click', () => {
        openForm({ name: 'Local', format: 'local', baseUrl: DEFAULT_LOCAL_URL, apiKey: '', models: [] });
        $('custom-detect').click();
    });

    $('custom-detect').addEventListener('click', () => {
        const button = $('custom-detect');
        setBusy(button, true, 'Detecting…');
        setStatus($('custom-status'), 'Asking the server for its models…');
        request({ type: 'discoverModels', provider: readForm() }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('custom-status'), reply.message + ' Is the server running?', 'error');
                return;
            }
            $('custom-models').value = reply.models.join(', ');
            setStatus($('custom-status'), `Found ${reply.models.length} model${reply.models.length === 1 ? '' : 's'}. Put your preferred one first.`, 'ok');
        });
    });
    $('custom-cancel').addEventListener('click', () => { form.hidden = true; });
    $('custom-format').addEventListener('change', urlHint);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const button = $('custom-save');
        setBusy(button, true, 'Saving…');
        request({ type: 'saveCustomProvider', provider: readForm() }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('custom-status'), reply.message, 'error');
            } else {
                form.hidden = true;
                preferredKeyProvider = reply.providerId;
            }
        });
    });

    $('custom-test').addEventListener('click', () => {
        const button = $('custom-test');
        setBusy(button, true, 'Testing…');
        setStatus($('custom-status'), 'Sending a test completion…');
        request({ type: 'testProvider', provider: readForm() }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('custom-status'), reply.message, 'error');
            } else {
                setStatus($('custom-status'), describeRun(reply.result), reply.result.runs[0]?.ok ? 'ok' : 'error');
            }
        });
    });

    $('open-instructions').addEventListener('click', () => vscode.postMessage({ type: 'openInstructionsFile' }));

    $('upload-instructions').addEventListener('click', () => {
        const button = $('upload-instructions');
        setBusy(button, true, 'Choose a file…');
        request({ type: 'uploadInstructions' }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('upload-status'), reply.message, 'error');
            } else if (reply.type === 'instructionsUploaded') {
                const warn = reply.total > 8000 ? ' Only the first ~8,000 characters are sent to the model.' : '';
                setStatus($('upload-status'), `Loaded ${reply.fileName} (${reply.chars.toLocaleString()} characters).${warn}`, warn ? 'error' : 'ok');
            } else {
                setStatus($('upload-status'), '');
            }
        });
    });

    $('usage-session').addEventListener('click', () => { usagePeriod = 'session'; renderUsage(); });
    $('usage-lifetime').addEventListener('click', () => { usagePeriod = 'lifetime'; renderUsage(); });
    $('usage-report').addEventListener('click', () => vscode.postMessage({ type: 'showUsageReport' }));
    $('pricing-refresh').addEventListener('click', () => {
        const button = $('pricing-refresh');
        setBusy(button, true, 'Refreshing…');
        request({ type: 'refreshPricing' }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus($('pricing-status'), 'Could not load the price catalog: ' + reply.message, 'error');
            }
        });
    });
    $('usage-reset').addEventListener('click', () => {
        vscode.postMessage({ type: 'resetUsage', scope: usagePeriod === 'lifetime' ? 'all' : 'session' });
    });

    $('run-benchmark').addEventListener('click', () => {
        const button = $('run-benchmark');
        const status = $('benchmark-status');
        setBusy(button, true, 'Measuring…');
        setStatus(status, 'Sending 5 sequential requests…');
        request({ type: 'runBenchmark' }, (reply) => {
            setBusy(button, false);
            if (reply.type === 'error') {
                setStatus(status, reply.message, 'error');
                return;
            }
            const r = reply.result;
            const failed = r.runs.find((run) => !run.ok);
            if (failed) {
                setStatus(status, 'Failed: ' + failed.error, 'error');
                return;
            }
            setStatus(status,
                `${r.provider} · ${r.model}\nCold: first token ${r.cold.ttftMs} ms, total ${r.cold.totalMs} ms\n` +
                `Warm p50: first token ${r.warmTtft.p50} ms, total ${r.warmTotal.p50} ms (p90 ${r.warmTotal.p90} ms)`, 'ok');
        });
    });

    $('reset').addEventListener('click', () => {
        vscode.postMessage({ type: 'reset' });
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.requestId && pending.has(message.requestId) && message.type !== 'benchmarkProgress') {
            const handler = pending.get(message.requestId);
            pending.delete(message.requestId);
            handler(message);
            return;
        }
        switch (message.type) {
            case 'config':
                applyConfig(message.config);
                break;
            case 'providers':
                applyProviders(message);
                break;
            case 'latency':
                renderLatency(message.stats);
                break;
            case 'usage':
                usage = { ...message.usage, now: message.now, providerLabels: message.providerLabels, pricing: message.pricing, catalog: message.catalog };
                renderUsage();
                // Don't wipe a price form the user is typing into.
                if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('.price-form')) {
                    renderPricing();
                }
                break;
            case 'benchmarkProgress':
                setStatus($('benchmark-status'), `Request ${message.index + 1}/5: ` +
                    (message.run.ok ? `${message.run.ttftMs} ms first token` : message.run.error));
                break;
            case 'instructionsStatus': {
                const files = message.status.workspaceFiles;
                $('instructions-status').textContent = files.length
                    ? `Workspace instructions active: ${files.join(', ')}`
                    : 'No workspace instructions file (.textify/instructions.md).';
                break;
            }
            case 'error':
                setStatus($('key-status'), message.message, 'error');
                break;
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
