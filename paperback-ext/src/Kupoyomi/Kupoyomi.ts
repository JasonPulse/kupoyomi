import {
  Chapter, ChapterDetails, ChapterProviding, ContentRating, DUISection, HomePageSectionsProviding,
  HomeSection, HomeSectionType, PagedResults, SearchRequest, SearchResultsProviding, SourceInfo,
  SourceIntents, SourceManga,
} from "@paperback/types";

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
export const KupoyomiInfo: SourceInfo = {
  version: "1.0.0",
  name: "Kupoyomi",
  icon: "icon.png",
  author: "Jason Clift",
  authorWebsite: "https://github.com/JasonPulse/kupoyomi",
  description: "Reads a self-hosted Kupoyomi library.",
  contentRating: ContentRating.ADULT,
  websiteBaseURL: "https://kupoyomi.network-gnomes.com",
  sourceTags: [],
  intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.SETTINGS_UI,
};

type PbSeries = {
  id: string; title: string; description: string | null; status: string;
  cover: string | null; chapters: number; lastUpload: string | null;
};
type PbChapter = {
  id: string; number: number; pages: number | null;
  scanlator: string | null; uploaded: string | null; read: boolean; lastPage: number;
};

const DEFAULT_URL = "https://kupoyomi.network-gnomes.com";

export class Kupoyomi implements ChapterProviding, SearchResultsProviding, HomePageSectionsProviding {
  private readonly stateManager = App.createSourceStateManager();

  readonly requestManager = App.createRequestManager({
    requestsPerSecond: 8,
    requestTimeout: 20_000,
  });

  /** The server address is the only thing worth configuring, so it is the whole menu. */
  async getSourceMenu(): Promise<DUISection> {
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
            set: async (newValue: string) => {
              await this.stateManager.store("serverUrl", newValue.replace(/\/+$/, ""));
            },
          }),
        }),
      ],
    });
  }

  private async baseUrl(): Promise<string> {
    const stored = await this.stateManager.retrieve("serverUrl") as string | undefined;
    return (stored && stored.length > 0 ? stored : DEFAULT_URL).replace(/\/+$/, "");
  }

  private async getJson<T>(path: string): Promise<T> {
    const base = await this.baseUrl();
    const response = await this.requestManager.schedule(
      App.createRequest({ url: `${base}${path}`, method: "GET" }), 1);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Kupoyomi returned ${response.status} for ${path}`);
    }
    return JSON.parse(response.data as string) as T;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const s = await this.getJson<PbSeries>(`/api/pb/series/${encodeURIComponent(mangaId)}`);
    const base = await this.baseUrl();
    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [s.title],
        image: s.cover ? `${base}${s.cover}` : "",
        status: s.status === "COMPLETED" ? "Completed" : "Ongoing",
        desc: s.description ?? "",
        author: "",
        artist: "",
        hentai: false,
      }),
    });
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const chapters = await this.getJson<PbChapter[]>(`/api/pb/series/${encodeURIComponent(mangaId)}/chapters`);
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

  async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
    const base = await this.baseUrl();
    const { pages } = await this.getJson<{ pages: string[] }>(
      `/api/pb/chapter/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}`);
    return App.createChapterDetails({
      id: chapterId,
      mangaId,
      pages: pages.map((p) => `${base}${p}`),
    });
  }

  async getSearchResults(query: SearchRequest, _metadata: unknown): Promise<PagedResults> {
    const term = (query.title ?? "").trim();
    const series = await this.getJson<PbSeries[]>(
      `/api/pb/series${term ? `?q=${encodeURIComponent(term)}` : ""}`);
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

  /** Required by the interface. Both sections send everything at once, so there is no
   *  further page to hand back -- an empty result is the honest answer. */
  async getViewMoreItems(homepageSectionId: string, _metadata: unknown): Promise<PagedResults> {
    const series = await this.getJson<PbSeries[]>("/api/pb/series");
    const base = await this.baseUrl();
    const ordered = homepageSectionId === "all"
      ? [...series].sort((a, b) => a.title.localeCompare(b.title))
      : series;
    return App.createPagedResults({
      results: ordered.map((s) => App.createPartialSourceManga({
        mangaId: s.id, title: s.title,
        image: s.cover ? `${base}${s.cover}` : "",
        subtitle: `${s.chapters} chapters`,
      })),
    });
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    // Sections are announced empty first so the app can lay them out, then filled.
    const recent = App.createHomeSection({
      id: "recent", title: "Recently updated", containsMoreItems: false, type: HomeSectionType.singleRowNormal,
    });
    sectionCallback(recent);

    const series = await this.getJson<PbSeries[]>("/api/pb/series");
    const base = await this.baseUrl();
    const tile = (s: PbSeries): ReturnType<typeof App.createPartialSourceManga> =>
      App.createPartialSourceManga({
        mangaId: s.id, title: s.title,
        image: s.cover ? `${base}${s.cover}` : "",
        subtitle: `${s.chapters} chapters`,
      });

    recent.items = series.slice(0, 24).map(tile);
    sectionCallback(recent);

    const all = App.createHomeSection({
      id: "all", title: "Everything", containsMoreItems: false, type: HomeSectionType.singleRowNormal,
    });
    all.items = [...series].sort((a, b) => a.title.localeCompare(b.title)).map(tile);
    sectionCallback(all);
  }
}
