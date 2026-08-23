import {
  Chapter, ChapterDetails, ChapterProviding, ContentRating, DUIForm, DUISection,
  HomePageSectionsProviding, HomeSection, HomeSectionType, MangaProgress,
  MangaProgressProviding, PagedResults, SearchRequest, SearchResultsProviding, SourceInfo,
  SourceIntents, SourceManga, TrackerActionQueue,
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
  version: "1.2.0",
  name: "Kupoyomi",
  icon: "icon.png",
  author: "Jason Clift",
  authorWebsite: "https://github.com/JasonPulse/kupoyomi",
  description: "Reads a self-hosted Kupoyomi library.",
  contentRating: ContentRating.ADULT,
  websiteBaseURL: "https://kupoyomi.network-gnomes.com",
  sourceTags: [],
  // MANGA_TRACKING is what puts the read/unread controls and the progress form in front
  // of the user. Without it Paperback treats read state as its own private business and
  // the server's progress ledger is write-only from the client's side.
  intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.MANGA_TRACKING
    | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.SETTINGS_UI,
};

type PbSeries = {
  id: string; title: string; description: string | null; status: string;
  cover: string | null; chapters: number; lastUpload: string | null;
  /** When the library last gained a chapter. What "recently updated" is ordered by. */
  lastAdded: string | null;
};
type PbChapter = {
  id: string; number: number; pages: number | null;
  scanlator: string | null; uploaded: string | null; read: boolean; lastPage: number;
};

const DEFAULT_URL = "https://kupoyomi.network-gnomes.com";

/** How many tiles a View More page hands back. Enough to fill a screen, small enough
 *  that a 4,000-chapter library does not arrive as one response. */
const PAGE_SIZE = 60;

export class Kupoyomi implements ChapterProviding, SearchResultsProviding,
  HomePageSectionsProviding, MangaProgressProviding {
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

  private async postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const base = await this.baseUrl();
    const response = await this.requestManager.schedule(App.createRequest({
      url: `${base}${path}`, method: "POST",
      headers: { "content-type": "application/json" },
      data: JSON.stringify(payload),
    }), 1);
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

  /**
   * The View More page, which is the only place in Paperback that lays titles out as a
   * scrollable grid rather than a single sideways row. Both sections are marked as having
   * more items so that page is reachable at all; a section that claims to be complete
   * gets no way in, and a library of forty titles is unusable one swipe at a time.
   */
  async getViewMoreItems(homepageSectionId: string, metadata: unknown): Promise<PagedResults> {
    const page = Number((metadata as { page?: number } | undefined)?.page ?? 0);
    const series = await this.getJson<PbSeries[]>("/api/pb/series");
    const ordered = homepageSectionId === "all"
      ? [...series].sort((a, b) => a.title.localeCompare(b.title))
      : series;
    const slice = ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const base = await this.baseUrl();
    return App.createPagedResults({
      results: slice.map((s) => this.tile(s, base, homepageSectionId === "recent")),
      // Undefined metadata is how the app is told to stop asking. Returning a page
      // number past the end instead makes it loop on an empty response forever.
      metadata: (page + 1) * PAGE_SIZE < ordered.length ? { page: page + 1 } : undefined,
    });
  }

  /** "3h ago", "2d ago". Short enough for a tile subtitle. */
  private static since(iso: string | null): string {
    if (!iso) return "";
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return "just now";
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
  }

  private tile(s: PbSeries, base: string, withWhen = false): ReturnType<typeof App.createPartialSourceManga> {
    const when = withWhen ? Kupoyomi.since(s.lastAdded) : "";
    return App.createPartialSourceManga({
      mangaId: s.id,
      title: s.title,
      image: s.cover ? `${base}${s.cover}` : "",
      // The date is the point of the recently-updated row: without it there is no way to
      // tell whether the order means anything.
      subtitle: when ? `${when} \u00b7 ${s.chapters} ch` : `${s.chapters} chapter${s.chapters === 1 ? "" : "s"}`,
    });
  }

  async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
    // Sections are announced empty first so the app can lay them out, then filled.
    const recent = App.createHomeSection({
      id: "recent", title: "Recently updated", containsMoreItems: true, type: HomeSectionType.singleRowNormal,
    });
    sectionCallback(recent);

    const series = await this.getJson<PbSeries[]>("/api/pb/series");
    const base = await this.baseUrl();

    // The server returns them newest-first by when this library gained a chapter, so no
    // sorting here: doing it again in the client is how the two drift apart.
    recent.items = series.slice(0, 24).map((s) => this.tile(s, base, true));
    sectionCallback(recent);

    const all = App.createHomeSection({
      id: "all", title: "Everything", containsMoreItems: true, type: HomeSectionType.singleRowNormal,
    });
    all.items = [...series].sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, PAGE_SIZE).map((s) => this.tile(s, base));
    sectionCallback(all);
  }

  // --- Read state -----------------------------------------------------------------
  // Progress lives on the server, so it survives reinstalling the app and follows the
  // series through a source migration. Chapter ids are numbers, which is what makes that
  // work: nothing here refers to a source's own chapter id.

  async getMangaProgress(mangaId: string): Promise<MangaProgress | undefined> {
    const { lastReadChapter } = await this.getJson<{ lastReadChapter: number | null }>(
      `/api/pb/series/${encodeURIComponent(mangaId)}/progress`);
    if (lastReadChapter === null) return undefined;
    return App.createMangaProgress({ mangaId, lastReadChapterNumber: lastReadChapter });
  }

  /**
   * Paperback batches "mark as read" into a queue and hands it over here. Each action is
   * discarded once the server has it and retried otherwise, so a phone that was offline
   * catches up instead of losing the marks.
   */
  async processChapterReadActionQueue(actionQueue: TrackerActionQueue): Promise<void> {
    for (const action of await actionQueue.queuedChapterReadActions()) {
      try {
        await this.postJson("/api/pb/progress", {
          seriesId: Number(action.mangaId),
          chapter: action.sourceChapterId,
          completed: true,
        });
        await actionQueue.discardChapterReadAction(action);
      } catch {
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
  async getMangaProgressManagementForm(mangaId: string): Promise<DUIForm> {
    const chapters = await this.getJson<PbChapter[]>(
      `/api/pb/series/${encodeURIComponent(mangaId)}/chapters`);
    const highest = chapters.length > 0 ? Math.max(...chapters.map((c) => c.number)) : 0;
    const { lastReadChapter } = await this.getJson<{ lastReadChapter: number | null }>(
      `/api/pb/series/${encodeURIComponent(mangaId)}/progress`);
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
                set: async (newValue: number) => { target = newValue; },
              }),
            }),
          ],
        }),
      ],
      onSubmit: async (values: Record<string, unknown>) => {
        const upto = Number(values["lastRead"] ?? target);
        if (!(upto > 0)) return;
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
