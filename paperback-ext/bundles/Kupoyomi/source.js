(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.Sources = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BadgeColor = void 0;
var BadgeColor;
(function (BadgeColor) {
    BadgeColor["BLUE"] = "default";
    BadgeColor["GREEN"] = "success";
    BadgeColor["GREY"] = "info";
    BadgeColor["YELLOW"] = "warning";
    BadgeColor["RED"] = "danger";
})(BadgeColor = exports.BadgeColor || (exports.BadgeColor = {}));

},{}],2:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],3:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomeSectionType = void 0;
var HomeSectionType;
(function (HomeSectionType) {
    HomeSectionType["singleRowNormal"] = "singleRowNormal";
    HomeSectionType["singleRowLarge"] = "singleRowLarge";
    HomeSectionType["doubleRow"] = "doubleRow";
    HomeSectionType["featured"] = "featured";
})(HomeSectionType = exports.HomeSectionType || (exports.HomeSectionType = {}));

},{}],4:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],5:[function(require,module,exports){
"use strict";
/**
 * Request objects hold information for a particular source (see sources for example)
 * This allows us to to use a generic api to make the calls against any source
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.urlEncodeObject = exports.convertTime = exports.Source = void 0;
/**
* @deprecated Use {@link PaperbackExtensionBase}
*/
class Source {
    constructor(cheerio) {
        this.cheerio = cheerio;
    }
    /**
     * @deprecated use {@link Source.getSearchResults getSearchResults} instead
     */
    searchRequest(query, metadata) {
        return this.getSearchResults(query, metadata);
    }
    /**
     * @deprecated use {@link Source.getSearchTags} instead
     */
    async getTags() {
        // @ts-ignore
        return this.getSearchTags?.();
    }
}
exports.Source = Source;
// Many sites use '[x] time ago' - Figured it would be good to handle these cases in general
function convertTime(timeAgo) {
    let time;
    let trimmed = Number((/\d*/.exec(timeAgo) ?? [])[0]);
    trimmed = (trimmed == 0 && timeAgo.includes('a')) ? 1 : trimmed;
    if (timeAgo.includes('minutes')) {
        time = new Date(Date.now() - trimmed * 60000);
    }
    else if (timeAgo.includes('hours')) {
        time = new Date(Date.now() - trimmed * 3600000);
    }
    else if (timeAgo.includes('days')) {
        time = new Date(Date.now() - trimmed * 86400000);
    }
    else if (timeAgo.includes('year') || timeAgo.includes('years')) {
        time = new Date(Date.now() - trimmed * 31556952000);
    }
    else {
        time = new Date(Date.now());
    }
    return time;
}
exports.convertTime = convertTime;
/**
 * When a function requires a POST body, it always should be defined as a JsonObject
 * and then passed through this function to ensure that it's encoded properly.
 * @param obj
 */
function urlEncodeObject(obj) {
    let ret = {};
    for (const entry of Object.entries(obj)) {
        ret[encodeURIComponent(entry[0])] = encodeURIComponent(entry[1]);
    }
    return ret;
}
exports.urlEncodeObject = urlEncodeObject;

},{}],6:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContentRating = exports.SourceIntents = void 0;
var SourceIntents;
(function (SourceIntents) {
    SourceIntents[SourceIntents["MANGA_CHAPTERS"] = 1] = "MANGA_CHAPTERS";
    SourceIntents[SourceIntents["MANGA_TRACKING"] = 2] = "MANGA_TRACKING";
    SourceIntents[SourceIntents["HOMEPAGE_SECTIONS"] = 4] = "HOMEPAGE_SECTIONS";
    SourceIntents[SourceIntents["COLLECTION_MANAGEMENT"] = 8] = "COLLECTION_MANAGEMENT";
    SourceIntents[SourceIntents["CLOUDFLARE_BYPASS_REQUIRED"] = 16] = "CLOUDFLARE_BYPASS_REQUIRED";
    SourceIntents[SourceIntents["SETTINGS_UI"] = 32] = "SETTINGS_UI";
})(SourceIntents = exports.SourceIntents || (exports.SourceIntents = {}));
/**
 * A content rating to be attributed to each source.
 */
var ContentRating;
(function (ContentRating) {
    ContentRating["EVERYONE"] = "EVERYONE";
    ContentRating["MATURE"] = "MATURE";
    ContentRating["ADULT"] = "ADULT";
})(ContentRating = exports.ContentRating || (exports.ContentRating = {}));

},{}],7:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./Source"), exports);
__exportStar(require("./ByteArray"), exports);
__exportStar(require("./Badge"), exports);
__exportStar(require("./interfaces"), exports);
__exportStar(require("./SourceInfo"), exports);
__exportStar(require("./HomeSectionType"), exports);
__exportStar(require("./PaperbackExtensionBase"), exports);

},{"./Badge":1,"./ByteArray":2,"./HomeSectionType":3,"./PaperbackExtensionBase":4,"./Source":5,"./SourceInfo":6,"./interfaces":15}],8:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],9:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],10:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],11:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],12:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],13:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],14:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],15:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./ChapterProviding"), exports);
__exportStar(require("./CloudflareBypassRequestProviding"), exports);
__exportStar(require("./HomePageSectionsProviding"), exports);
__exportStar(require("./MangaProgressProviding"), exports);
__exportStar(require("./MangaProviding"), exports);
__exportStar(require("./RequestManagerProviding"), exports);
__exportStar(require("./SearchResultsProviding"), exports);

},{"./ChapterProviding":8,"./CloudflareBypassRequestProviding":9,"./HomePageSectionsProviding":10,"./MangaProgressProviding":11,"./MangaProviding":12,"./RequestManagerProviding":13,"./SearchResultsProviding":14}],16:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],17:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],18:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],19:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],20:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],21:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],22:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],23:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],24:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],25:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],26:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],27:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],28:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],29:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],30:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],31:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],32:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],33:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],34:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],35:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],36:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],37:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],38:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],39:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],40:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],41:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],42:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],43:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],44:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],45:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],46:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],47:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],48:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],49:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],50:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],51:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],52:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],53:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],54:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],55:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],56:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],57:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],58:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],59:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

},{}],60:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./DynamicUI/Exports/DUIBinding"), exports);
__exportStar(require("./DynamicUI/Exports/DUIForm"), exports);
__exportStar(require("./DynamicUI/Exports/DUIFormRow"), exports);
__exportStar(require("./DynamicUI/Exports/DUISection"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIHeader"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIInputField"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUILabel"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUILink"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIMultilineLabel"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUINavigationButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIOAuthButton"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISecureInputField"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISelect"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUIStepper"), exports);
__exportStar(require("./DynamicUI/Rows/Exports/DUISwitch"), exports);
__exportStar(require("./Exports/ChapterDetails"), exports);
__exportStar(require("./Exports/Chapter"), exports);
__exportStar(require("./Exports/Cookie"), exports);
__exportStar(require("./Exports/HomeSection"), exports);
__exportStar(require("./Exports/IconText"), exports);
__exportStar(require("./Exports/MangaInfo"), exports);
__exportStar(require("./Exports/MangaProgress"), exports);
__exportStar(require("./Exports/PartialSourceManga"), exports);
__exportStar(require("./Exports/MangaUpdates"), exports);
__exportStar(require("./Exports/PBCanvas"), exports);
__exportStar(require("./Exports/PBImage"), exports);
__exportStar(require("./Exports/PagedResults"), exports);
__exportStar(require("./Exports/RawData"), exports);
__exportStar(require("./Exports/Request"), exports);
__exportStar(require("./Exports/SourceInterceptor"), exports);
__exportStar(require("./Exports/RequestManager"), exports);
__exportStar(require("./Exports/Response"), exports);
__exportStar(require("./Exports/SearchField"), exports);
__exportStar(require("./Exports/SearchRequest"), exports);
__exportStar(require("./Exports/SourceCookieStore"), exports);
__exportStar(require("./Exports/SourceManga"), exports);
__exportStar(require("./Exports/SecureStateManager"), exports);
__exportStar(require("./Exports/SourceStateManager"), exports);
__exportStar(require("./Exports/Tag"), exports);
__exportStar(require("./Exports/TagSection"), exports);
__exportStar(require("./Exports/TrackedMangaChapterReadAction"), exports);
__exportStar(require("./Exports/TrackerActionQueue"), exports);

},{"./DynamicUI/Exports/DUIBinding":17,"./DynamicUI/Exports/DUIForm":18,"./DynamicUI/Exports/DUIFormRow":19,"./DynamicUI/Exports/DUISection":20,"./DynamicUI/Rows/Exports/DUIButton":21,"./DynamicUI/Rows/Exports/DUIHeader":22,"./DynamicUI/Rows/Exports/DUIInputField":23,"./DynamicUI/Rows/Exports/DUILabel":24,"./DynamicUI/Rows/Exports/DUILink":25,"./DynamicUI/Rows/Exports/DUIMultilineLabel":26,"./DynamicUI/Rows/Exports/DUINavigationButton":27,"./DynamicUI/Rows/Exports/DUIOAuthButton":28,"./DynamicUI/Rows/Exports/DUISecureInputField":29,"./DynamicUI/Rows/Exports/DUISelect":30,"./DynamicUI/Rows/Exports/DUIStepper":31,"./DynamicUI/Rows/Exports/DUISwitch":32,"./Exports/Chapter":33,"./Exports/ChapterDetails":34,"./Exports/Cookie":35,"./Exports/HomeSection":36,"./Exports/IconText":37,"./Exports/MangaInfo":38,"./Exports/MangaProgress":39,"./Exports/MangaUpdates":40,"./Exports/PBCanvas":41,"./Exports/PBImage":42,"./Exports/PagedResults":43,"./Exports/PartialSourceManga":44,"./Exports/RawData":45,"./Exports/Request":46,"./Exports/RequestManager":47,"./Exports/Response":48,"./Exports/SearchField":49,"./Exports/SearchRequest":50,"./Exports/SecureStateManager":51,"./Exports/SourceCookieStore":52,"./Exports/SourceInterceptor":53,"./Exports/SourceManga":54,"./Exports/SourceStateManager":55,"./Exports/Tag":56,"./Exports/TagSection":57,"./Exports/TrackedMangaChapterReadAction":58,"./Exports/TrackerActionQueue":59}],61:[function(require,module,exports){
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./generated/_exports"), exports);
__exportStar(require("./base/index"), exports);
__exportStar(require("./compat/DyamicUI"), exports);

},{"./base/index":7,"./compat/DyamicUI":16,"./generated/_exports":60}],62:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Kupoyomi = exports.KupoyomiInfo = void 0;
const types_1 = require("@paperback/types");
/**
 * Kupoyomi source for Paperback.
 *
 * Pinned to the 0.8 SDK because Paperback 0.8.11 speaks that API; the 1.0.0-alpha line
 * targets a newer app. Do not upgrade without upgrading the app.
 *
 * Chapters are addressed by their number, not by a database id, because Kupoyomi's ledger
 * is keyed on chapter number. A series that later moves to a different source keeps the
 * same chapter ids, so reading position survives a migration -- which is the entire point
 * of the server and is worth preserving in the client.
 */
exports.KupoyomiInfo = {
    version: "1.1.0",
    name: "Kupoyomi",
    icon: "icon.png",
    author: "Jason Clift",
    authorWebsite: "https://github.com/JasonPulse/kupoyomi",
    description: "Reads a self-hosted Kupoyomi library.",
    contentRating: types_1.ContentRating.ADULT,
    websiteBaseURL: "https://kupoyomi.network-gnomes.com",
    sourceTags: [],
    // MANGA_TRACKING is what puts the read/unread controls and the progress form in front
    // of the user. Without it Paperback treats read state as its own private business and
    // the server's progress ledger is write-only from the client's side.
    intents: types_1.SourceIntents.MANGA_CHAPTERS | types_1.SourceIntents.MANGA_TRACKING
        | types_1.SourceIntents.HOMEPAGE_SECTIONS | types_1.SourceIntents.SETTINGS_UI,
};
const DEFAULT_URL = "https://kupoyomi.network-gnomes.com";
/** How many tiles a View More page hands back. Enough to fill a screen, small enough
 *  that a 4,000-chapter library does not arrive as one response. */
const PAGE_SIZE = 60;
class Kupoyomi {
    constructor() {
        this.stateManager = App.createSourceStateManager();
        this.requestManager = App.createRequestManager({
            requestsPerSecond: 8,
            requestTimeout: 20000,
        });
    }
    /** The server address is the only thing worth configuring, so it is the whole menu. */
    async getSourceMenu() {
        return App.createDUISection({
            id: "settings",
            header: "Kupoyomi server",
            isHidden: false,
            rows: async () => [
                App.createDUIInputField({
                    id: "serverUrl",
                    label: "Server URL",
                    value: App.createDUIBinding({
                        get: async () => (await this.baseUrl()),
                        set: async (newValue) => {
                            await this.stateManager.store("serverUrl", newValue.replace(/\/+$/, ""));
                        },
                    }),
                }),
            ],
        });
    }
    async baseUrl() {
        const stored = await this.stateManager.retrieve("serverUrl");
        return (stored && stored.length > 0 ? stored : DEFAULT_URL).replace(/\/+$/, "");
    }
    async getJson(path) {
        const base = await this.baseUrl();
        const response = await this.requestManager.schedule(App.createRequest({ url: `${base}${path}`, method: "GET" }), 1);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Kupoyomi returned ${response.status} for ${path}`);
        }
        return JSON.parse(response.data);
    }
    async postJson(path, payload) {
        const base = await this.baseUrl();
        const response = await this.requestManager.schedule(App.createRequest({
            url: `${base}${path}`, method: "POST",
            headers: { "content-type": "application/json" },
            data: JSON.stringify(payload),
        }), 1);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Kupoyomi returned ${response.status} for ${path}`);
        }
        return JSON.parse(response.data);
    }
    async getMangaDetails(mangaId) {
        const s = await this.getJson(`/api/pb/series/${encodeURIComponent(mangaId)}`);
        const base = await this.baseUrl();
        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [s.title],
                image: s.cover ? `${base}${s.cover}` : "",
                status: s.status === "COMPLETED" ? "Completed" : "Ongoing",
                // An empty desc renders as nothing at all, which reads as a broken extension
                // rather than as a series whose source never published a synopsis. Say so.
                desc: s.description ?? `No synopsis on file. ${s.chapters} chapter${s.chapters === 1 ? "" : "s"} held`
                    + `${s.lastUpload ? `, newest ${s.lastUpload}` : ""}.`,
                author: "",
                artist: "",
                hentai: false,
            }),
        });
    }
    async getChapters(mangaId) {
        const chapters = await this.getJson(`/api/pb/series/${encodeURIComponent(mangaId)}/chapters`);
        return chapters.map((c, i) => App.createChapter({
            id: c.id,
            chapNum: c.number,
            langCode: "🇬🇧",
            name: c.scanlator ? `Chapter ${c.number} [${c.scanlator}]` : `Chapter ${c.number}`,
            volume: 0,
            group: c.scanlator ?? "",
            time: c.uploaded ? new Date(c.uploaded) : new Date(0),
            sortingIndex: chapters.length - i,
        }));
    }
    async getChapterDetails(mangaId, chapterId) {
        const base = await this.baseUrl();
        const { pages } = await this.getJson(`/api/pb/chapter/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}`);
        return App.createChapterDetails({
            id: chapterId,
            mangaId,
            pages: pages.map((p) => `${base}${p}`),
        });
    }
    async getSearchResults(query, _metadata) {
        const term = (query.title ?? "").trim();
        const series = await this.getJson(`/api/pb/series${term ? `?q=${encodeURIComponent(term)}` : ""}`);
        const base = await this.baseUrl();
        return App.createPagedResults({
            results: series.map((s) => App.createPartialSourceManga({
                mangaId: s.id,
                title: s.title,
                image: s.cover ? `${base}${s.cover}` : "",
                subtitle: `${s.chapters} chapters`,
            })),
        });
    }
    /**
     * The View More page, which is the only place in Paperback that lays titles out as a
     * scrollable grid rather than a single sideways row. Both sections are marked as having
     * more items so that page is reachable at all; a section that claims to be complete
     * gets no way in, and a library of forty titles is unusable one swipe at a time.
     */
    async getViewMoreItems(homepageSectionId, metadata) {
        const page = Number(metadata?.page ?? 0);
        const series = await this.getJson("/api/pb/series");
        const ordered = homepageSectionId === "all"
            ? [...series].sort((a, b) => a.title.localeCompare(b.title))
            : series;
        const slice = ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const base = await this.baseUrl();
        return App.createPagedResults({
            results: slice.map((s) => this.tile(s, base)),
            // Undefined metadata is how the app is told to stop asking. Returning a page
            // number past the end instead makes it loop on an empty response forever.
            metadata: (page + 1) * PAGE_SIZE < ordered.length ? { page: page + 1 } : undefined,
        });
    }
    tile(s, base) {
        return App.createPartialSourceManga({
            mangaId: s.id,
            title: s.title,
            image: s.cover ? `${base}${s.cover}` : "",
            subtitle: `${s.chapters} chapter${s.chapters === 1 ? "" : "s"}`,
        });
    }
    async getHomePageSections(sectionCallback) {
        // Sections are announced empty first so the app can lay them out, then filled.
        const recent = App.createHomeSection({
            id: "recent", title: "Recently updated", containsMoreItems: true, type: types_1.HomeSectionType.singleRowNormal,
        });
        sectionCallback(recent);
        const series = await this.getJson("/api/pb/series");
        const base = await this.baseUrl();
        recent.items = series.slice(0, 24).map((s) => this.tile(s, base));
        sectionCallback(recent);
        const all = App.createHomeSection({
            id: "all", title: "Everything", containsMoreItems: true, type: types_1.HomeSectionType.singleRowNormal,
        });
        all.items = [...series].sort((a, b) => a.title.localeCompare(b.title))
            .slice(0, PAGE_SIZE).map((s) => this.tile(s, base));
        sectionCallback(all);
    }
    // --- Read state -----------------------------------------------------------------
    // Progress lives on the server, so it survives reinstalling the app and follows the
    // series through a source migration. Chapter ids are numbers, which is what makes that
    // work: nothing here refers to a source's own chapter id.
    async getMangaProgress(mangaId) {
        const { lastReadChapter } = await this.getJson(`/api/pb/series/${encodeURIComponent(mangaId)}/progress`);
        if (lastReadChapter === null)
            return undefined;
        return App.createMangaProgress({ mangaId, lastReadChapterNumber: lastReadChapter });
    }
    /**
     * Paperback batches "mark as read" into a queue and hands it over here. Each action is
     * discarded once the server has it and retried otherwise, so a phone that was offline
     * catches up instead of losing the marks.
     */
    async processChapterReadActionQueue(actionQueue) {
        for (const action of await actionQueue.queuedChapterReadActions()) {
            try {
                await this.postJson("/api/pb/progress", {
                    seriesId: Number(action.mangaId),
                    chapter: action.sourceChapterId,
                    completed: true,
                });
                await actionQueue.discardChapterReadAction(action);
            }
            catch {
                await actionQueue.retryChapterReadAction(action);
            }
        }
    }
    /**
     * The form behind "manage progress" on a series. One number: the chapter you have
     * already read up to. Submitting marks everything at or below it read in a single
     * request, which is the only sane way to handle a series you read somewhere else before
     * this library existed.
     */
    async getMangaProgressManagementForm(mangaId) {
        const chapters = await this.getJson(`/api/pb/series/${encodeURIComponent(mangaId)}/chapters`);
        const highest = chapters.length > 0 ? Math.max(...chapters.map((c) => c.number)) : 0;
        const { lastReadChapter } = await this.getJson(`/api/pb/series/${encodeURIComponent(mangaId)}/progress`);
        let target = lastReadChapter ?? 0;
        return App.createDUIForm({
            sections: async () => [
                App.createDUISection({
                    id: "progress",
                    header: "Read up to",
                    footer: `Marks every chapter at or below this number as read. ${highest} is the newest held.`,
                    isHidden: false,
                    rows: async () => [
                        App.createDUIStepper({
                            id: "lastRead",
                            label: "Chapter",
                            min: 0,
                            max: highest,
                            step: 1,
                            value: App.createDUIBinding({
                                get: async () => target,
                                set: async (newValue) => { target = newValue; },
                            }),
                        }),
                    ],
                }),
            ],
            onSubmit: async (values) => {
                const upto = Number(values["lastRead"] ?? target);
                if (!(upto > 0))
                    return;
                // The chapter id is the number formatted the way the ledger stores it, because
                // that is the key the server looks up.
                await this.postJson("/api/pb/progress/upto", {
                    seriesId: Number(mangaId),
                    chapter: upto.toFixed(4),
                });
            },
        });
    }
}
exports.Kupoyomi = Kupoyomi;

},{"@paperback/types":61}]},{},[62])(62)
});
