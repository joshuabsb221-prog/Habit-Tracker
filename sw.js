/* Root-scope shim. A worker's scope is capped by its own path, so the worker has to be
   served from the site root to control the whole app; the implementation stays in assets/. */
importScripts('assets/sw.js');
