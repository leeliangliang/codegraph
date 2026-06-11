#ifndef CODEGRAPH_XCHELPER_SUPPORT_H
#define CODEGRAPH_XCHELPER_SUPPORT_H

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*codegraph_xc_output_path_receiver_t)(const char *path, void *context);

int codegraph_xc_collect_unit_output_paths(
    const char *store_path,
    const char *lib_path,
    const char *source_root,
    const char *const *allowed_output_names,
    int allowed_output_name_count,
    codegraph_xc_output_path_receiver_t receiver,
    void *receiver_context,
    char *error_buffer,
    int error_buffer_size);

#ifdef __cplusplus
}
#endif

#endif
