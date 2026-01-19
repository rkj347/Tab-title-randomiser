// Content script function to get tab details
function getTabDetails() {
  const iconLink = document.querySelector("link[rel='icon']") ||
                   document.querySelector("link[rel='shortcut icon']") ||
                   document.querySelector("link[rel*='icon']");

  if (!iconLink) {
    const origin = window.location.origin;
    const faviconUrl = `${origin}/favicon.ico`;
    const img = new Image();
    img.src = faviconUrl;
    
    if (img.complete) {
      return {
        title: document.title,
        faviconHref: faviconUrl,
        faviconRel: 'icon'
      };
    }
  }

  if (!iconLink) {
    const metaIcon = document.querySelector("meta[itemprop='image']");
    if (metaIcon) {
      return {
        title: document.title,
        faviconHref: metaIcon.content,
        faviconRel: 'icon'
      };
    }
  }

  return {
    title: document.title,
    faviconHref: iconLink ? iconLink.href : null,
    faviconRel: iconLink ? iconLink.rel : 'icon',
  };
}

// Content script function to purge tab details
function purgeTabDetails() {
  document.title = '\u200B'; // Zero-width space
  const blankFavicon = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const faviconLinks = document.querySelectorAll("link[rel*='icon']");
  let faviconSet = false;
  faviconLinks.forEach(link => {
     link.href = blankFavicon;
     link.rel = 'icon';
     faviconSet = true;
  });
  if (!faviconSet) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = blankFavicon;
    document.head.appendChild(link);
  }
}

// Core function to purge all tabs
async function manageTabsPurge() {
  console.log('Executing manageTabsPurge via keyboard shortcut');

  // Check if an original state is already saved
  const { originalTabDetails: existingSavedState } = await chrome.storage.local.get('originalTabDetails');

  // Save state of ALL tabs concurrently *only if not already saved*
  if (!existingSavedState || Object.keys(existingSavedState).length === 0) {
    console.log('No existing saved state found. Saving current tab states...');
    const tabs = await chrome.tabs.query({});
    const originalDetails = {};
    const savePromises = [];
    for (const tab of tabs) {
      if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
        savePromises.push(
          chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: getTabDetails,
          }).then(results => {
            if (results && results[0] && results[0].result) {
              originalDetails[tab.id] = results[0].result;
            } else {
               console.warn(`Could not retrieve details for tab ${tab.id} during save state.`);
            }
          }).catch(error => {
            console.error(`Error saving state for tab ${tab.id}:`, error);
          })
        );
      }
    }
    await Promise.allSettled(savePromises);
    await chrome.storage.local.set({ originalTabDetails: originalDetails });
    console.log('Original tab details stored for undo.');
  } else {
    console.log('Existing saved state found. Skipping state save.');
  }

  // Purge all eligible tabs
  const tabsToModify = await chrome.tabs.query({});
  const actionPromises = [];
  
  console.log('Mode: purgeAll - Purging all eligible tabs.');
  for (const tab of tabsToModify) {
     if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
       actionPromises.push(
         chrome.scripting.executeScript({
           target: { tabId: tab.id, frameIds: [0] },
           func: purgeTabDetails,
         }).catch(e => console.error(`Error purging tab ${tab.id}:`, e))
       );
     }
  }
  await Promise.allSettled(actionPromises);
  console.log('Purge complete for purgeAll mode.');
}

// Content script function to restore tab details
function restoreTabDetails(details) {
  console.log('restoreTabDetails', details);
  document.title = details.title;
  const blankFavicon = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  let linkRestoredOrRemoved = false;

  // First remove all existing favicon links
  document.querySelectorAll("link[rel*='icon']").forEach(link => {
    console.log('removing link', link);
    link.remove();
  });

  // If we have the original favicon, try to restore it
  if (details.faviconHref) {
    const link = document.createElement('link');
    link.rel = details.faviconRel || 'icon';
    link.href = details.faviconHref;
    try {
      document.head.appendChild(link);
      linkRestoredOrRemoved = true;
    } catch (e) {
      console.error('Error appending restored link:', e);
    }
  }

  // If we couldn't restore the original favicon (either because it wasn't saved
  // or because restoration failed), set it to blank
  if (!linkRestoredOrRemoved) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = blankFavicon;
    try {
      document.head.appendChild(link);
    } catch (e) {
      console.error('Error setting blank favicon:', e);
    }
  }
}

// Function to undo the changes
async function undoChanges() {
  console.log("Executing undoChanges via keyboard shortcut");
  const { originalTabDetails } = await chrome.storage.local.get('originalTabDetails');

  if (!originalTabDetails || Object.keys(originalTabDetails).length === 0) {
    console.log('No original tab details found to restore.');
    return;
  }

  const restorePromises = [];
  for (const tabIdStr in originalTabDetails) {
     const tabId = parseInt(tabIdStr);
     if (isNaN(tabId)) {
        console.warn(`Invalid tabId found in storage: ${tabIdStr}, skipping restore.`);
        continue;
     }
     const details = originalTabDetails[tabIdStr];
     console.log("Restoring tab", tabId, "with details:", details);
     restorePromises.push(
       chrome.scripting.executeScript({
         target: { tabId: tabId, frameIds: [0] },
         func: restoreTabDetails,
         args: [details],
       }).catch(error => {
         if (error.message.includes('No tab with id') || error.message.includes('Invalid tab ID')) {
           console.warn(`Tab ${tabId} not found or invalid during restore, skipping.`);
         } else {
           console.error(`Error restoring tab ${tabId}:`, error);
         }
       })
     );
  }
  await Promise.allSettled(restorePromises);
  await chrome.storage.local.remove('originalTabDetails');
  console.log('Tab details restoration attempted and storage cleared.');
}

// Initialize: Log that service worker is ready
console.log('Tab Title Randomiser background service worker loaded');

// Listen for keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  console.log('=== COMMAND RECEIVED ===', command);
  console.log('Command type:', typeof command);
  console.log('Command value:', JSON.stringify(command));
  
  try {
    if (command === 'purge-tabs') {
      console.log('Executing purge-tabs');
      await manageTabsPurge();
    } else if (command === 'undo-tabs') {
      console.log('Executing undo-tabs - calling undoChanges()');
      await undoChanges();
      console.log('undoChanges() completed successfully');
    } else {
      console.warn('Unknown command received:', command);
    }
  } catch (error) {
    console.error('ERROR executing command:', command, error);
    console.error('Error stack:', error.stack);
  }
});

// Log all registered commands on startup
chrome.commands.getAll((commands) => {
  console.log('Registered commands:', commands);
});
