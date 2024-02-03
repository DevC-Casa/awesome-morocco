#!/usr/bin/bun

await import("../env.mjs");
import { type BlogsRecord, getXataClient } from "~/xata";
import { extractRssFeed } from "~/utils/extract-rss-feed";
import type { SelectedPick } from "@xata.io/client";

/**
 * This script is used to fetch the RSS feed from blogs and update the article table in the database.
 * The Approach is to fetch the the blog with the oldest  last_rss_retrieved_at  and extract the articles from the RSS feed
 * We only need to extract article for blog that already have an RSS feed and already validated by admin (draft = false)
 * This script should be scheduled to run every day with github action
 */
const MAX_ARTICLES_PER_BLOG = 20;
type OPError = {
  index: number;
  message: string;
};

type BulkOPerationError = {
  errors: OPError[];
};

type Article = {
  url: string;
  published_at: Date;
};

const addBulkArticles = async (articles: Article[]): Promise<number> => {
  // as xada doesn't support avoid adding duplicates and return an error in case of one of the article already exists
  // we need to check the error and only add the articles that doesn't already exists
  try {
    await getXataClient().db.articles.create(articles);
    return articles.length;
  } catch (error) {
    // in case of duplication we will get an error with the articles that already exists
    // the error should be an array of articles that already exists
    // we need to remove them from the articles array and try again
    const castedError = error as BulkOPerationError;
    if (
      castedError?.errors &&
      Array.isArray(castedError.errors) &&
      castedError.errors.length > 0
    ) {
      const indexes = castedError.errors.map(
        (e: { index: number; message: string }) => e.index,
      );
      const missedArticles = articles.filter(
        (_, index) => !indexes.includes(index),
      );
      if (missedArticles.length === 0) {
        return 0;
      }
      try {
        await getXataClient().db.articles.create(missedArticles);
        return missedArticles.length;
      } catch (error) {
        throw error;
      }
    } else {
      throw error;
    }
  }
};

const fetchRssFeed = async (
  blog: SelectedPick<BlogsRecord, ("title" | "rss" | "id")[]>,
) => {
  console.log(`\n \n🚀 Fetching RSS feed for ${blog.title} - ${blog.rss} 🚀`);
  const feed = await extractRssFeed(blog.rss!);

  if (feed?.entries === undefined) {
    console.warn("🚨 Error getting articles from rss url");
    return;
  }
  console.log(`✅ ${feed?.entries.length} articles found`);

  if (feed.entries.length < 2) {
    console.warn("🚨 Feed articles count is less than 3");
    return;
  }
  // TODO: we should probably add more check regarding article publication date
  const articles = feed.entries
    .filter(
      (entry) => entry.published !== undefined && entry.link !== undefined,
    )
    .slice(0, MAX_ARTICLES_PER_BLOG)
    .map((article) => {
      return {
        url: article.link,
        published_at: new Date(article.published ?? ("01/01/2020" as string)),
      };
    }) as Article[];

  console.log(
    `✅ ${articles.length} are valid and has been extracted from the RSS feed`,
  );

  try {
    const numberOfArticleAdded = await addBulkArticles(articles);
    console.log(`✅ ${numberOfArticleAdded} articles added to the database 🚀`);
    // update the blog last_rss_retrieved_at
    await getXataClient().db.blogs.update(blog.id, {
      last_rss_retrieved_at: new Date(),
    });
  } catch (error) {
    console.error("🚨 Error adding articles to the database", error);
    return;
  }
};

const rssRefresher = async () => {
  const blogs = await getXataClient()
    .db.blogs.select(["rss", "title", "id"])
    .filter({ draft: false, rss: { $contains: "http" } })
    .sort("last_rss_retrieved_at", "asc")
    .getMany();

  for (const blog of blogs) {
    await fetchRssFeed(blog);
  }
};

await rssRefresher();
