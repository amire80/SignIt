/* *************************************************************** */
/* TODO ********************************************************** */
// [ ] multi-videos (?)
// [ ] WT/Lexeme defenition
// [ ] underline available words in the page
// [ ] support link right click

/* Phases ******************************************************** */
// state: up
// listen to event 1
// loading saved params from localstorage
// state: loading
// loading available sign languages
// loading vidéos urls
// create context menu
// state: ready

// change language asked from popup box
// update global var
// state: loading
// loading vidéos urls
// set local storage
// state: ready


/* *************************************************************** */
/* Sparql endpoints *********************************************** */
const sparqlEndpoints = {
	lingualibre: { url: "https://lingualibre.org/bigdata/namespace/wdq/sparql", verb: "POST" },
	wikidata: { url: "https://query.wikidata.org/sparql", verb: "GET" },
	commons: { url: "https://commons-query.wikimedia.org/sparql", verb: "GET" },
	"dictionaire-francophone": { url: "https://www.dictionnairedesfrancophones.org/sparql", verb: "" },
};
/* *************************************************************** */
/* Sparql ******************************************************** */
// Lingualibre: All languages (P4) for which media type (P24) is video (Q88890)
const sparqlSignLanguagesQuery = 'SELECT ?id ?idLabel WHERE { ?id prop:P2 entity:Q4 . ?id prop:P24 entity:Q88890 . SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". } }';
// Lingualibre: Given a language (P4) with media video, fetch the list of writen word (P7), url (P3) speakers (P5)
const sparqlSignVideosQuery = 'SELECT ?word ?filename ?speaker WHERE { ?record prop:P2 entity:Q2 . ?record prop:P4 entity:$(lang) . ?record prop:P7 ?word . ?record prop:P3 ?filename . ?record prop:P5 ?speakerItem . ?speakerItem rdfs:label ?speaker filter ( lang( ?speaker ) = "en" ) . }';
// Wikidata: All Sign languages who have a Commons lingualibre category
const sparqlFilesInCategoryQuery = `SELECT ?file ?url ?title
WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "Generator" ;
                    wikibase:endpoint "commons.wikimedia.org" ;
                    mwapi:gcmtitle "Category:Videos Langue des signes française" ;
                    mwapi:generator "categorymembers" ;
                    mwapi:gcmtype "file" ;
                    mwapi:gcmlimit "max" .
    ?title wikibase:apiOutput mwapi:title .
    ?pageid wikibase:apiOutput "@pageid" .
  }
  BIND (URI(CONCAT('https://commons.wikimedia.org/entity/M', ?pageid)) AS ?file)
  BIND (URI(CONCAT('https://commons.wikimedia.org/wiki/', ?title)) AS ?url)
}`

/* *************************************************************** */
/* Init state if no localStorage ********************************* */
var state = 'up', // up / loading / ready / error
	records = {},
	signLanguages = {},
	uiLanguages = {},
	// Default values, will be stored in localStorage as well for persistency.
	params = {
		signLanguage: 'Q99628', // for videos : French Sign language
		uiLanguage: 'Q150', // for interface : French
		historylimit: 6,
		history: ['lapin', 'crabe', 'fraise'], // Some fun
		wpintegration: true,
		twospeed: true,
	};

/* *************************************************************** */
/* i18n context ************************************************** */	
	var supportedUiLanguages = [
		{ wdQid: "Q150", nativeName: "Français", associatedWikt: "fr", associatedAnchorId: "#Français" },
		{ wdQid: "Q1860", nativeName: "English", associatedWikt: "en", associatedAnchorId: "#English" }
	//	{ wdQid: "Q1321", nativeName: "Español", associatedWikt: "es", associatedAnchorId: "#Español" },
	//	{ wdQid: "Q7930", nativeName: "Magalasy", associatedWikt: "mg", associatedAnchorId: "" },
	];
	var filterArrayBy = function (arr, key, value){
		return arr.filter(item => (item[key]==value) )[0]
	};

	// Init internationalisation support with Banana-i18n.js
	banana = new Banana('fr');
	loadI18nLocalization(params.uiLanguage);
	// Add url support
	banana.registerParserPlugin('link', (nodes) => {
		return '<a href="' + nodes[0] + '">' + nodes[1] + '</a>';
	});

/* *************************************************************** */
/* Toolbox functions ********************************************* */

// Check if localStorage has parameter values, else use hard coded value from above.
async function getStoredParam( name ) {
	var tmp = await browser.storage.local.get( name );
	params[ name ] = tmp[ name ] || params[ name ] || null;
	return params[ name ];
}

// Save parameter and value in localStorage
async function storeParam( name, value ) {
	// If the value is an array, we make a copy of it to avoid dead references issues
	if ( Array.isArray( value ) ) {
		value = Array.from( value ); // copy
	}
	// create object { name: value }
	var tmp = {};
	tmp[ name ] = value;
	// reset params
	params[ name ] = value;
	return await browser.storage.local.set( tmp );
}

// ???
async function checkInjection( tab ) {
	try {
		await browser.tabs.sendMessage( tab, { command: "ping" } );
	} catch ( error ) {
		var i, scripts = browser.runtime.getManifest().content_scripts[ 0 ].js,
			stylesheets = browser.runtime.getManifest().content_scripts[ 0 ].css;

		for( i = 0; i < scripts.length; i++ ) {
			await browser.tabs.executeScript( tab, { file: scripts[ i ] } );
		}
		for( i = 0; i < stylesheets.length; i++ ) {
			await browser.tabs.insertCSS( tab, { file: stylesheets[ i ] } );
		}
	}
}

// Get sign languages covered by Lingualibre
async function getSignLanguagesWithVideos() {
	var i, signLanguage,
		signLanguages = {},
		response = await $.post( sparqlEndpoints.lingualibre.url, { format: 'json', query: sparqlSignLanguagesQuery } );

	for ( i = 0; i < response.results.bindings.length; i++ ) {
		signLanguage = response.results.bindings[ i ];
		signLanguages[ signLanguage.id.value.split( '/' ).pop() ] = signLanguage.idLabel.value;
	}
	return signLanguages; // [{ Q99628: "langue des signes française", ... }]
}

// Get UI languages with translations on github
async function getUiLanguagesWithTranslations() {
	var formerData = { 
		Q150: "Français", 
		Q1860: "English"
	}
	return supportedUiLanguages;
}
// Loading all vidéos of a given sign language. Format:
// records = { word: { filename: url, speaker: name }, ... };
async function getAllRecords( signLanguage ) {
	var i, record, word, response,
		records = {};

	state = 'loading';

	response = await $.post( sparqlEndpoints.lingualibre.url, { format: 'json', query: sparqlSignVideosQuery.replace( '$(lang)', signLanguage ) } );

	for ( i = 0; i < response.results.bindings.length; i++ ) {
		record = response.results.bindings[ i ];
		word = record.word.value.toLowerCase();
		if ( records.hasOwnProperty( word ) === false ) {
			records[ word ] = [];
		}
		records[ word ].push( { filename: record.filename.value.replace( 'http://', 'https://' ), speaker: record.speaker.value } );
	}

	state = 'ready';

	console.log( Object.keys( records ).length + ' records loaded' );
	return records;
}

// Given a word string, check if exist in available records data, if so return data on that word
function wordToFiles( word ) {
	// could use a switch for clarity
	if ( records.hasOwnProperty( word ) === false ) {
		word = word.toLowerCase();
		if ( records.hasOwnProperty( word ) === false ) {
			return null;
		}
	}
	return records[ word ];
}

function normalize( word ) {
	return word.trim();
}

async function fetchJS(filepath) {
	try {
		const response = await fetch(`${filepath}`, {
			method: 'GET',
			credentials: 'same-origin'
		});
		const content = await response.json();
		return content;
	} catch (error) { console.error(error); }
}
// messages = await fetchJS(`i18n/${iso}.json`);

// Loading all UI translations
async function loadI18nLocalization( uiLanguageQid ) {
	var messages = {};
	console.log("uiLanguageQid)",uiLanguageQid);
	console.log("supportedUiLanguages",supportedUiLanguages);
	console.log("filterArrayBy1",filterArrayBy);
	var filterArrayBy = function (arr, key, value){
		return arr.filter(item => (item[key]==value) )[0]
	};
	console.log("filterArrayBy2",filterArrayBy);

	state = 'loading';
	lang = supportedUiLanguages.filter(item => (item.wdQid==uiLanguageQid) )
	iso = lang[0]["associatedWikt"];
	//filterArrayBy(supportedUiLanguages,"wdQid",uiLanguageQid)["associatedWikt"]; // uiLanguage is a Qid
	console.log("uiLanguageQid",uiLanguageQid);
	console.log("iso",iso)

	// Load messages
	const res = await fetch(`i18n/${iso}.json`)
	messages = await res.json();
	console.log("messages",messages["si-popup-settings-title"])
	// Load messages into localisation
	banana.load(messages, iso); // Load localized messages (should be conditional to empty data for that local)

	// Declare localisation
	banana.setLocale(iso); // Change to new locale
	console.log("background 215",banana.i18n('si-popup-settings-title'))
	console.log("background 216",banana);
	state = 'ready';

	console.log( Object.keys( messages ).length + ' messages loaded' );
}

// Given language's Qid, reload list of available videos and records/words data
async function changeLanguage( newLang ) {
	records = await getAllRecords( newLang );
	await storeParam( 'signLanguage', newLang ); // localStorage save
}

// Given language's Qid, reload available translations
async function changeUiLanguage( newLang ) {
	console.log('changeUiLanguage newLang', newLang); // => 'Q150' for french
	messages = await loadI18nLocalization( newLang );
	await storeParam( 'uiLanguage', newLang ); // localStorage save
}

/* *************************************************************** */
/* Browser interactions ****************************************** */

// Create a context menu item    ??? what is that?
browser.contextMenus.create({
  id: "signit",
  title: 'Lingua Libre SignIt',
  contexts: ["selection"]
}, function() {return;});

// Send a message to the content script when our context menu is clicked   // <-- This seems to run the overlay popup
browser.contextMenus.onClicked.addListener( async function( info, tab ) { // var tab not used ? Can remove ?
	switch (info.menuItemId) {
		case "signit":
			var tabs = await browser.tabs.query( { active: true, currentWindow: true } ),
				word = normalize( info.selectionText );

			await checkInjection( tabs[ 0 ].id );
			browser.tabs.sendMessage( tabs[ 0 ].id, {
				command: "signit.sign",
				selection: word,
				files: wordToFiles( word ),
			} );
			storeParam( 'history', [ word, ...params.history ] );
			break;
	}
});

//
browser.runtime.onMessage.addListener( async function ( message ) {
	var coords; // var coords not used ? Can remove ?

	if ( message.command === 'signit.getfiles' ) {
		return records[ message.word ] || records[ message.word.toLowerCase() ] || [];
	}
} );

// Edit the header of all pages on-the-fly to bypass Content-Security-Policy
browser.webRequest.onHeadersReceived.addListener(info => {
    const headers = info.responseHeaders; // original headers
    for (let i=headers.length-1; i>=0; --i) {
        let header = headers[i].name.toLowerCase();
        if (header === "content-security-policy") { // csp header is found
            // modifying media-src; this implies that the directive is already present
            headers[i].value = headers[i].value.replace("media-src", "media-src https://commons.wikimedia.org https://upload.wikimedia.org");
        }
    }
    // return modified headers
    return {responseHeaders: headers};
}, {
    urls: [ "<all_urls>" ], // match all pages
    types: [ "main_frame" ] // to focus only the main document of a tab
}, ["blocking", "responseHeaders"]);



/* *************************************************************** */
/* Main ********************************************************** */
async function main() {
	state = 'loading';
	// Get local storage value if exist, else get default values
	await getStoredParam( 'history' );
	await getStoredParam( 'historylimit' );
	await getStoredParam( 'wpintegration' );
	await getStoredParam( 'twospeed' );
	// storeParam( 'twospeed', params.twospeed ); // so
	signLanguage = await getStoredParam( 'signLanguage' );
	signLanguages = await getSignLanguagesWithVideos();
	uiLanguage = await getStoredParam( 'uiLanguage' );
	console.log("supportedUiLanguages",supportedUiLanguages)
	uiLanguages = supportedUiLanguages;
	records = await getAllRecords( signLanguage );
	state = 'ready';
}
// Run it
main();
