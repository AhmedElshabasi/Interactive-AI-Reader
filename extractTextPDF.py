import PyPDF2

def extract_text_from_pdf(file_path):
    text = ""
    with open(file_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        for page_num in range(len(reader.pages)):
            page = reader.pages[page_num]
            text += page.extract_text() or ''
    return text

def save_text_to_file(text, output_path):
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(text)

# Example usage:
pdf_path = "Ammous,_Saifedean_The_Bitcoin_standard_the_decentralized_alternative.pdf"  # Replace with your PDF 
output_text_path = "output_text.txt"  # Desired output text file name

pdf_text = extract_text_from_pdf(pdf_path)
save_text_to_file(pdf_text, output_text_path)
print(pdf_text)
