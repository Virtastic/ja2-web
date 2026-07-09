#include "Object_Cache.h"
#include "HImage.h"
#include "VObject.h"
#include <map>


static std::map<cache_key_t, SGPVObject> gObjectCache;


void ClearObjectCache()
{
	// This function is semi-hidden and supposed to be used only by
	// VObject.cc during shutdown to prevent double frees.
	gObjectCache.clear();
}


SGPVObject * GetVObject(cache_key_t const filename)
{
	// First, try to look up an already cached vobject.
	auto const cachePos{ gObjectCache.find(filename) };
	if (cachePos != gObjectCache.end())
	{
		return &cachePos->second;
	}

	// Not found: load it and add it to the cache. If the image is missing (e.g. a
	// graphic the JA2 demo doesn't ship, like the main-menu background), fall back
	// to a blank placeholder instead of aborting.
	SGPImage* raw = nullptr;
	try
	{
		raw = CreateImage(filename, IMAGE_ALLIMAGEDATA);
	}
	catch (...)
	{
		SLOGW("Could not load cached image '{}' — using a blank placeholder", filename);
		raw = CreatePlaceholderImage();
	}
	AutoSGPImage image{ raw };
	auto const newPos{ gObjectCache.emplace(filename, image.get()) };
	return &newPos.first->second;
}


bool RemoveVObject(cache_key_t const filename)
{
	return gObjectCache.erase(filename) != 0;
}


void BltVideoObject(SGPVSurface * const dst, cache_key_t const filename,
	UINT16 const subIndex, int const x, int const y)
{
	BltVideoObject(dst, GetVObject(filename), subIndex, x, y);
}
