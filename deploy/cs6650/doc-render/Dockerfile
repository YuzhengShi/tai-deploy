# The image that turns a document into page images and the words of each page (docs/DOCUMENTS.md, docs/COURSE_DOCS.md). Built on the host by `tai_live.sh doc build`; never rebuilt by a deploy.
#
# poppler-utils (pdfinfo, pdftoppm, pdftotext) for a PDF, and LibreOffice (writer, impress and calc only, headless, no recommended packages: no Java, no desktop integration) that makes a PDF of a
# PowerPoint, Word or Excel file before it goes the same way; fonts for the files that do not carry their own (Carlito and Caladea take the places of Calibri and Cambria, the Office defaults, with the same
# metrics, so that a slide's lines break where its author's did). On the Python image the host already has: the apt packages come from the Debian mirrors, not from Docker Hub, so the build needs no
# pull. python3 is for two small scripts (render-words.py, office-kind.py). No user is made: the host passes --user, and nothing in here is written at run time (the root file system is read-only; /out is
# the host's directory and /tmp is memory; LibreOffice gets a profile of its own there for each conversion).
#
# BASE_IMAGE can name another copy of the same image (Docker Hub limits anonymous pulls per address and this host shares one):
#   docker build --build-arg BASE_IMAGE=mirror.gcr.io/library/python:3.12-slim ...
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

LABEL tai-doc-image="1"
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LC_ALL=C.UTF-8

# fontconfig is installed on purpose: its cache of the fonts is made here, because at run time there is no place to write one but the memory-backed /tmp
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      poppler-utils fontconfig \
      fonts-liberation fonts-dejavu-core fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
      libreoffice-writer libreoffice-impress libreoffice-calc; \
    fc-cache -f; \
    command -v soffice pdfinfo pdftoppm pdftotext > /dev/null; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# The scripts come after the packages on purpose: a change to them rebuilds the last two steps, not the install above.
COPY doc-render render-words.py office-kind.py /usr/local/bin/
# (the files are LF in the repository; this makes a CRLF copy from a Windows checkout work all the same)
RUN sed -i 's/\r$//' /usr/local/bin/doc-render /usr/local/bin/render-words.py /usr/local/bin/office-kind.py \
 && chmod 0755 /usr/local/bin/doc-render /usr/local/bin/render-words.py /usr/local/bin/office-kind.py
