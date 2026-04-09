# TalkJS Chat Tab - Diagnostics & Troubleshooting Guide

## Overview
This document provides guidance on diagnosing and fixing issues with the TalkJS chat functionality in the Lister application.

## Recent Improvements (Added)

### 1. **Enhanced Logging** ✓
- Added comprehensive console logging in `initTalkJS()` function
- Added detailed logging in `renderChatDetail()` function  
- Added logging in `onChatTabOpen()` function
- Added logging in the Electron main process for token extraction

### 2. **Improved CSS** ✓
- Added proper CSS for `.#chat-talkjs-wrap` and `#chat-talkjs-container`
- Ensured proper flexbox layout with overflow handling
- Added `display: flex !important` for active state

### 3. **Better Error Handling** ✓
- Added DOM element validation before operations
- Added try-catch blocks around TalkJS operations
- Improved error messages displayed to users
- Added class manipulation for better state tracking

## Diagnostic Steps

### Step 1: Check Browser Console
Open Developer Tools (F12) and check the Console tab when:
1. Opening the app
2. Clicking on the Chat tab  
3. Selecting an order to view conversation

**Look for these log patterns:**

```
[onChatTabOpen] Tab opened
[TalkJS] ========== INIT START ==========
[TalkJS] Cookie found, fetching user and token...
[TalkJS] userId: <ID> userName: <USERNAME>
[TalkJS] ✓ Auth token acquired
[TalkJS] ✓ Talk library ready
[TalkJS] ✓ Session created: ...
[ChatDetail] ========== RENDER START ==========
[ChatDetail] Conversation ID: <ID>
[ChatDetail] ✓ Chatbox mounted successfully
```

### Step 2: Known Issues & Solutions

#### **Issue: "Talk is not defined"**
- **Cause:** TalkJS library failed to load from CDN
- **Solution:** Check if `https://cdn.talkjs.com/talk.js` is accessible
- **Fix:** Ensure internet connection, check firewall/proxy settings

#### **Issue: "No token acquired"** ⚠️
- **Cause:** TalkJS token extraction failed
- **Solution:** Check Electron main process logs
- **Location:** See `get-talkjs-token` handler in main.js
- **Possible Causes:**
  - WebSocket interceptor not working
  - Eldorado cookie invalid or expired  
  - Eldorado API changed endpoint
  - Network timeout (20s limit)

#### **Issue: "No conversation ID"**
- **Cause:** Order data missing `talkJsConversationId` field
- **Solution:** Verify Eldorado API is returning conversation IDs
- **Check:** Open DevTools → Network tab → Look for `/api/orders/...` response

#### **Issue: DOM elements not found**
- **Cause:** HTML structure might have changed
- **Solution:** Verify these elements exist in DOM:
  - `#chat-detail` - Main container
  - `#chat-empty-state` - Empty state placeholder
  - `#chat-talkjs-wrap` - TalkJS wrapper
  - `#chat-talkjs-container` - Mount point for TalkJS

## Verifying the Fix

### In Console:
```javascript
// Check if TalkJS loaded
window.Talk !== undefined

// Check session state
window.talkjsSession // Should not be null after initialization

// Check container
document.getElementById('chat-talkjs-container')
```

### Visual Indicators:
- ✓ Chat tab opens without errors
- ✓ Order list appears on left side
- ✓ Clicking order shows loading spinner
- ✓ TalkJS chatbox appears with conversation

## Recovery Commands

If chat still doesn't work after these changes, try:

```javascript
// Clear and reinitialize
talkjsSession = null;
talkjsInitPromise = null;
resetChatDetail();

// Then retry
initTalkJS();
```

## Configuration

### TalkJS AppId
- **Current:** `49mLECOW`
- **Location:** Line ~6063 in index.html
- **Note:** This should match your TalkJS account

### Timeout Settings
- **Token fetch timeout:** 20 seconds (main.js:378)
- **Can be adjusted if network is slow**

## Files Modified
1. `index.html` - Added logging and CSS improvements
2. `main.js` - Added token extraction logging

## Next Steps if Still Not Working

1. **Check Eldorado API:**
   - Verify `/api/users/me` returns user ID
   - Verify `/api/orders/me/seller/orders` returns `talkJsConversationId`

2. **Check TalkJS Account:**
   - Verify AppId is correct
   - Verify account has active subscription
   - Check TalkJS console for errors

3. **Check Network:**
   - Verify WebSocket connections allowed to `wss://app.talkjs.com/*`
   - Verify no firewall blocking TalkJS domains

## Support Resources
- [TalkJS Documentation](https://talkjs.com/docs)
- [TalkJS Chat UI](https://talkjs.com/docs/UI_Components/JavaScript)
- Check console logs with timestamps for correlation

---
*Last Updated: 2024*
