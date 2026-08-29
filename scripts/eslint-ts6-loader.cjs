const Module = require('node:module');

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (request === 'typescript') {
        return originalResolveFilename.call(this, 'typescript6', parent, isMain, options);
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
};
