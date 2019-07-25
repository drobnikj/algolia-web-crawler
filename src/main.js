const Apify = require('apify');
const _ = require('underscore');
const Promise = require('bluebird');
const algoliasearch = require('algoliasearch');
const algoliaIndex = require('./algolia_index');
const { setUpCrawler } = require('./crawler');

Apify.main(async () => {
    const input = await Apify.getInput();
    const { algolia, crawlerName } = input;

    const algoliaApiKey = algolia.apiKey || process.env.ALGOLIA_API_KEY;
    const algoliaClient = algoliasearch(algolia.appId, algoliaApiKey);
    const algoliaSearchIndex = algoliaClient.initIndex(algolia.indexName);

    const crawler = await setUpCrawler(input);
    await crawler.run();

    const dataset = await Apify.openDataset();
    const datasetInfo = await dataset.getInfo();
    console.log(`Crawler finished, it found ${datasetInfo.cleanItemCount} pages to index!`);

    const pagesInIndex = await algoliaIndex.browseAll(algoliaSearchIndex, crawlerName);
    console.log(`There are ${pagesInIndex.length} pages in the index for ${crawlerName}.`);
    const pagesIndexByUrl = _.indexBy(pagesInIndex, 'url');

    const pagesDiff = {
        pagesToAdd: {},
        pagesToUpdate: {},
        pagesToRemove: pagesIndexByUrl,
    };

    // TODO: Pagination
    const datasetResult = await dataset.getData({ clean: true });
    datasetResult.items.forEach((page) => {
        const { url } = page;
        if (pagesIndexByUrl[url]) {
            pagesDiff.pagesToUpdate[url] = {
                ...page,
                objectID: pagesIndexByUrl[url].objectID,
            };
        } else {
            pagesDiff.pagesToAdd[url] = page;
        }
        delete pagesDiff.pagesToRemove[url];
    });

    await Apify.setValue('OUTPUT', pagesDiff);
    await algoliaIndex.update(algoliaSearchIndex, pagesDiff);
});
