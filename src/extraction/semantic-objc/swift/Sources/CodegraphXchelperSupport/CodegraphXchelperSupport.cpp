#include "CodegraphXchelperSupport.h"

#include "IndexStoreDB/Index/IndexStoreLibraryProvider.h"
#include "indexstore/IndexStoreCXX.h"

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_set>
#include <vector>

using namespace indexstore;

static constexpr size_t kMaxIndexStoreStringLength = 1024 * 1024;

static std::string safe_string(indexstore_string_ref_t ref) {
  if (!ref.data || ref.length == 0) return std::string();
  if (ref.length > kMaxIndexStoreStringLength) return std::string();
  return std::string(ref.data, ref.length);
}

static std::string safe_string(const char *value) {
  if (!value) return std::string();
  return std::string(value);
}

static void set_error(char *buffer, int buffer_size, const std::string &message) {
  if (!buffer || buffer_size <= 0) return;
  std::snprintf(buffer, static_cast<size_t>(buffer_size), "%s", message.c_str());
}

static std::string strip_private_prefix(const std::string &path) {
  const char *prefix = "/private/";
  if (path.rfind(prefix, 0) == 0) {
    return path.substr(std::strlen("/private"));
  }
  return path;
}

static bool is_in_project(const std::string &path, const std::string &source_root) {
  const std::string p = strip_private_prefix(path);
  const std::string root = strip_private_prefix(source_root);
  return p == root || (p.size() > root.size() && p.rfind(root, 0) == 0 && p[root.size()] == '/');
}

static std::string basename(const std::string &path) {
  size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) return path;
  return path.substr(slash + 1);
}

extern "C" int codegraph_xc_collect_unit_output_paths(
    const char *store_path,
    const char *lib_path,
    const char *source_root,
    const char *const *allowed_output_names,
    int allowed_output_name_count,
    codegraph_xc_output_path_receiver_t receiver,
    void *receiver_context,
    char *error_buffer,
    int error_buffer_size) {
  if (!store_path || !lib_path || !source_root || !receiver) {
    set_error(error_buffer, error_buffer_size, "missing required argument");
    return 1;
  }

  std::unordered_set<std::string> allowed;
  for (int i = 0; i < allowed_output_name_count; ++i) {
    if (allowed_output_names[i]) allowed.insert(allowed_output_names[i]);
  }
  if (allowed.empty()) return 0;

  std::string load_error;
  auto library = IndexStoreDB::index::loadIndexStoreLibrary(lib_path, load_error);
  if (!library) {
    set_error(error_buffer, error_buffer_size, load_error.empty() ? "failed to load libIndexStore" : load_error);
    return 1;
  }

  const auto &api = library->api();
  indexstore_error_t store_error = nullptr;
  indexstore_t store = api.store_create(store_path, &store_error);
  if (store_error) {
    std::string message = safe_string(api.error_get_description(store_error));
    api.error_dispose(store_error);
    set_error(error_buffer, error_buffer_size, message.empty() ? "failed to open IndexStore" : message);
    return 1;
  }
  if (!store) {
    set_error(error_buffer, error_buffer_size, "failed to open IndexStore");
    return 1;
  }

  struct ApplyContext {
    const indexstore_functions_t *api;
    indexstore_t store;
    std::string root;
    const std::unordered_set<std::string> *allowed;
    std::unordered_set<std::string> seen;
    codegraph_xc_output_path_receiver_t receiver;
    void *receiver_context;
  } context{&api, store, std::string(source_root), &allowed, {}, receiver, receiver_context};

  api.store_units_apply_f(store, false, &context, [](void *raw_context, indexstore_string_ref_t unit_name_ref) -> bool {
    auto *context = static_cast<ApplyContext *>(raw_context);
    std::string unit_name = safe_string(unit_name_ref);
    if (unit_name.empty()) return true;

    indexstore_error_t read_error = nullptr;
    indexstore_unit_reader_t reader = context->api->unit_reader_create(
        context->store,
        unit_name.c_str(),
        &read_error);
    if (read_error) {
      context->api->error_dispose(read_error);
      return true;
    }
    if (!reader) return true;

    std::string main_file = safe_string(context->api->unit_reader_get_main_file(reader));
    std::string output_file = safe_string(context->api->unit_reader_get_output_file(reader));
    context->api->unit_reader_dispose(reader);

    if (main_file.empty() || !is_in_project(main_file, context->root)) return true;
    if (output_file.empty()) return true;
    if (!context->allowed->count(basename(output_file))) return true;

    if (context->seen.insert(output_file).second) {
      context->receiver(output_file.c_str(), context->receiver_context);
    }
    return true;
  });

  api.store_dispose(store);
  return 0;
}
