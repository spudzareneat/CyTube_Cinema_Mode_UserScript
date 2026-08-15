// ==UserScript==
// @name         CyTube Grindhouse Title Renamer
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Renames the page title on the 420Grindhouse room to "The Grindhouse"
// @match        https://cytu.be/r/420Grindhouse
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const TITLE = 'The Grindhouse';

    // CyTube JS keeps overwriting document.title (e.g. on now-playing changes).
    // Observing documentElement from document-start (before <head> exists yet)
    // catches both the title element being added and later text changes.
    new MutationObserver(() => {
        if (document.title !== TITLE) {
            document.title = TITLE;
        }
    }).observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
    });
})();
