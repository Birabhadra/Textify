(function () {
    const vscode = acquireVsCodeApi();

    const controls = Array.from(document.querySelectorAll('[data-key]'));
    const providerSelect = document.getElementById('provider');
    const modelOptions = document.getElementById('model-options');
    let providers = [];
    let applyingRemote = false;

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

    function applyConfig(config) {
        applyingRemote = true;
        for (const control of controls) {
            const key = control.dataset.key;
            if (key in config) {
                setControlValue(control, config[key]);
            }
        }
        updateModelOptions();
        applyingRemote = false;
    }

    function updateModelOptions() {
        const selectedProvider = providers.find((p) => p.id === providerSelect.value);
        modelOptions.innerHTML = '';
        if (!selectedProvider) {
            return;
        }
        for (const model of selectedProvider.models) {
            const option = document.createElement('option');
            option.value = model;
            modelOptions.appendChild(option);
        }
    }

    function applyProviders(list) {
        providers = list;
        const current = providerSelect.value;
        for (const provider of providers) {
            const option = document.createElement('option');
            option.value = provider.id;
            option.textContent = provider.label;
            providerSelect.appendChild(option);
        }
        providerSelect.value = current;
        updateModelOptions();
    }

    for (const control of controls) {
        const eventName = control.tagName === 'SELECT' || control.type === 'checkbox' ? 'change' : 'change';
        control.addEventListener(eventName, () => {
            if (applyingRemote) {
                return;
            }
            const key = control.dataset.key;
            const value = readControlValue(control);
            if (key === 'provider') {
                updateModelOptions();
            }
            vscode.postMessage({ type: 'update', key, value });
        });
    }

    document.getElementById('reset').addEventListener('click', () => {
        vscode.postMessage({ type: 'reset' });
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'config') {
            applyConfig(message.config);
        } else if (message.type === 'providers') {
            applyProviders(message.providers);
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
