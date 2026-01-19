// --- Helper Functions ---

// Loads domain mappings from the config file
async function loadDomainMappings() {
  try {
    const response = await fetch('data/domain_mappings.json');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const mappings = await response.json();
    // Basic validation: ensure it's an object
    if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
       console.error('Invalid format in domain_mappings.json. Expected an object.');
       return {}; // Return empty object on format error
    }
    // Further validation could check structure of inner objects (title/favicon)
    return mappings;
  } catch (error) {
    console.error("Error loading or parsing domain_mappings.json:", error);
    return {}; // Fallback to empty object
  }
}

// Core function to manage tabs based on mode ('purgeAll' or 'professional')
async function manageTabs(mode) {
  console.log(`Executing manageTabs with mode: ${mode}`);

  // Check if an original state is already saved
  const { originalTabDetails: existingSavedState } = await chrome.storage.local.get('originalTabDetails');

  // 1. Save state of ALL tabs concurrently *only if not already saved*
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

  // 2. Execute actions based on mode (using the already loaded tabs query if needed, or re-querying)
  // It might be slightly cleaner to just query again here for simplicity
  const tabsToModify = await chrome.tabs.query({});
  const actionPromises = [];

  if (mode === 'purgeAll') {
    console.log('Mode: purgeAll - Purging all eligible tabs.');
    for (const tab of tabsToModify) { // Use tabsToModify
       if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
         actionPromises.push(
           chrome.scripting.executeScript({
             target: { tabId: tab.id, frameIds: [0] },
             func: purgeTabDetails, // Blank out
           }).catch(e => console.error(`Error purging tab ${tab.id}:`, e))
         );
       }
    }
    await Promise.allSettled(actionPromises);
    console.log('Initial purge complete for purgeAll mode.');

  } else if (mode === 'professional') {
    console.log('Mode: professional - Applying random professional details.');

    // Step 2a: Load mappings
    const domainMappings = await loadDomainMappings();
    const mappingKeys = Object.keys(domainMappings);

    if (mappingKeys.length === 0) {
        console.error("Professional mode failed: No domain mappings loaded from data/domain_mappings.json. Cannot select random details.");
        return; // Stop processing this mode if no mappings available
    }
    console.log(`Loaded ${mappingKeys.length} mappings. Applying randomly.`);

    // Step 2b: Apply random mapping to each tab
    const applyRandomPromises = []; // Keep this name for clarity here
    for (const tab of tabsToModify) { // Use tabsToModify
       if (tab.id && tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
          // Select a random key/domain from the available mappings
          const randomKeyIndex = Math.floor(Math.random() * mappingKeys.length);
          const randomDomainKey = mappingKeys[randomKeyIndex];
          const randomDetails = domainMappings[randomDomainKey];

          console.log(`Tab ${tab.id}: Applying random details for domain '${randomDomainKey}':`, randomDetails);

          applyRandomPromises.push(
             chrome.scripting.executeScript({
                 target: { tabId: tab.id, frameIds: [0] },
                 func: setSpecificDetails, // Use the function that sets specific title/favicon
                 args: [randomDetails],
             }).catch(e => console.error(`Error applying random details to tab ${tab.id}:`, e))
         );
       }
    }
    // Use the correct promise array here
    await Promise.allSettled(applyRandomPromises); // Changed from actionPromises
    console.log('Application of random details complete for professional mode.');
  }

  // Use the correct promise array if purgeAll was selected
  if (mode === 'purgeAll') {
     await Promise.allSettled(actionPromises);
     console.log('Purge complete for purgeAll mode.');
  }

  console.log(`Tab modification process complete for mode: ${mode}.`);
}

// Function to undo the changes
async function undoChanges() {
  console.log("Executing undoChanges");
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
     console.log("details", details);
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

// --- Event Listeners ---

document.getElementById('purgeTabsBtn').addEventListener('click', () => manageTabs('purgeAll'));
document.getElementById('professionalModeBtn').addEventListener('click', () => manageTabs('professional'));
document.getElementById('undoPurgeBtn').addEventListener('click', undoChanges);


// --- Content Script Functions ---

// Gets current title and best favicon details.
function getTabDetails() {
    // 1. Try standard link tags first
  const iconLink = document.querySelector("link[rel='icon']") ||
                   document.querySelector("link[rel='shortcut icon']") ||
                   document.querySelector("link[rel*='icon']");

    // 2. If no link tags found, try direct favicon.ico
    if (!iconLink) {
      // Get the origin (e.g., https://www.google.com)
      const origin = window.location.origin;
      // Try the default favicon location
      const faviconUrl = `${origin}/favicon.ico`;
      
      // Test if favicon exists at this URL
      const img = new Image();
      img.src = faviconUrl;
      
      if (img.complete) {
        console.log('Found favicon.ico at root');
        return {
          title: document.title,
          faviconHref: faviconUrl,
          faviconRel: 'icon'
        };
      }
    }
  
    // 3. If still no favicon found, check meta tags
    if (!iconLink) {
      const metaIcon = document.querySelector("meta[itemprop='image']");
      if (metaIcon) {
        console.log('Found favicon in meta tag');
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

// Sets title to zero-width space and favicon to blank.
function purgeTabDetails() {
  document.title = '\u200B'; // Zero-width space
  const blankFavicon = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const faviconLinks = document.querySelectorAll("link[rel*='icon']");
  let faviconSet = false;
  faviconLinks.forEach(link => {
     link.href = blankFavicon;
     link.rel = 'icon'; // Standardize rel
     faviconSet = true;
  });
  if (!faviconSet) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = blankFavicon;
    document.head.appendChild(link);
  }
}

// NEW: Sets specific title and favicon based on provided details.
function setSpecificDetails(details) {
  console.log('[Content Script] setSpecificDetails started. Details:', details); // Log entry

  if (!details || !details.title || !details.favicon) {
     console.error('[Content Script] setSpecificDetails called with invalid details:', details);
     return;
  }
  document.title = details.title;
  console.log(`[Content Script] Title set to: ${details.title}`);

  // Remove existing icon links first
  const existingIcons = document.querySelectorAll("link[rel*='icon']");
  console.log(`[Content Script] Found ${existingIcons.length} existing icon links to remove.`);
  existingIcons.forEach(link => link.remove());
  console.log('[Content Script] Existing icon links removed.');

  // Create and add the new icon link
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/x-icon'; // Be explicit with type, might help
  link.href = details.favicon;
  console.log(`[Content Script] Creating new link with rel=icon, href=${details.favicon.substring(0, 50)}...`); // Log href (truncated)

  try {
    document.head.appendChild(link);
    console.log('[Content Script] New link appended to head.');

    // Attempt cache busting (may or may not work)
    console.log('[Content Script] Attempting cache bust...');
    const originalHref = link.href;
    link.href = ''; // Briefly set to empty
    // Force a reflow - reading offsetHeight is a common trick
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const reflow = document.body.offsetHeight;
    link.href = originalHref; // Set it back
    console.log('[Content Script] Cache bust attempt finished.');

  } catch (e) {
     console.error(`[Content Script] Error appending favicon link for title '${details.title}':`, e);
  }
}

// Restores original title and favicon.
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