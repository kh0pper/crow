/**
 * Theme Toggle for Capstone Companion
 * Handles light/dark mode switching with localStorage persistence
 * and system preference detection.
 */

(function() {
    'use strict';

    const STORAGE_KEY = 'capstone-companion-theme';
    const DARK = 'dark';
    const LIGHT = 'light';

    /**
     * Get the current theme from localStorage or system preference
     */
    function getPreferredTheme() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return stored;
        }
        // Check system preference
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
    }

    /**
     * Apply theme to document
     */
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(STORAGE_KEY, theme);
        updateToggleButton(theme);
    }

    /**
     * Update the toggle button icon
     */
    function updateToggleButton(theme) {
        const btn = document.getElementById('theme-toggle');
        if (!btn) return;

        const sunIcon = btn.querySelector('.theme-icon-sun');
        const moonIcon = btn.querySelector('.theme-icon-moon');

        if (theme === DARK) {
            if (sunIcon) sunIcon.style.display = 'block';
            if (moonIcon) moonIcon.style.display = 'none';
            btn.setAttribute('aria-label', 'Switch to light mode');
        } else {
            if (sunIcon) sunIcon.style.display = 'none';
            if (moonIcon) moonIcon.style.display = 'block';
            btn.setAttribute('aria-label', 'Switch to dark mode');
        }
    }

    /**
     * Toggle between light and dark themes
     */
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || LIGHT;
        const next = current === DARK ? LIGHT : DARK;
        setTheme(next);
    }

    /**
     * Initialize theme on page load
     */
    function init() {
        // Apply theme immediately (flicker prevention is handled by inline script)
        const theme = getPreferredTheme();
        setTheme(theme);

        // Set up toggle button
        const btn = document.getElementById('theme-toggle');
        if (btn) {
            btn.addEventListener('click', toggleTheme);
        }

        // Listen for system preference changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            // Only auto-switch if user hasn't manually set a preference
            if (!localStorage.getItem(STORAGE_KEY)) {
                setTheme(e.matches ? DARK : LIGHT);
            }
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose toggle function globally for external use
    window.toggleTheme = toggleTheme;
})();
