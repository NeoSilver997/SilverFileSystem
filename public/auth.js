/**
 * Shared authentication utilities for SilverFileSystem
 * Include this script in all protected pages
 */

// Check if user is authenticated
async function checkAuth() {
    const token = localStorage.getItem('silverfs_token');
    if (!token) {
        window.location.href = '/login.html';
        return false;
    }

    try {
        const response = await fetch('/api/auth/verify', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await response.json();

        if (!response.ok || !data.valid) {
            logout();
            return false;
        }
    } catch (error) {
        logout();
        return false;
    }

    return true;
}

// Get JWT token from localStorage
function getToken() {
    return localStorage.getItem('silverfs_token');
}

// Get current user info
function getCurrentUser() {
    const userStr = localStorage.getItem('silverfs_user');
    if (userStr) {
        try {
            return JSON.parse(userStr);
        } catch (e) {
            return null;
        }
    }
    return null;
}

// Logout function
function logout() {
    localStorage.removeItem('silverfs_token');
    localStorage.removeItem('silverfs_user');
    window.location.href = '/login.html';
}

// Fetch wrapper that automatically includes JWT token
async function authFetch(url, options = {}) {
    const token = getToken();
    
    if (!token) {
        window.location.href = '/login.html';
        throw new Error('No authentication token');
    }

    // Add authorization header
    const headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
    };

    const response = await fetch(url, {
        ...options,
        headers
    });

    // If unauthorized, redirect to login
    if (response.status === 401) {
        localStorage.removeItem('silverfs_token');
        localStorage.removeItem('silverfs_user');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }

    return response;
}

// Initialize authentication on page load
(function() {
    // Check if we're on the login page
    if (window.location.pathname === '/login.html') {
        return; // Don't check auth on login page
    }

    // Check authentication
    (async () => {
        await checkAuth();
    })();
})();
